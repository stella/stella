import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import "./reader.css";

// ── AST types (mirror of document-ast.ts) ─────────────────

type Inline =
  | { type: "text"; text: string; anonymized?: true }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "line-break" };

type HeadingBlock = {
  id: string;
  anchorId: string;
  type: "heading";
  level: 1 | 2 | 3;
  role?: string;
  inlines: Inline[];
  plainText: string;
};

type ParagraphBlock = {
  id: string;
  anchorId: string;
  type: "paragraph";
  role?: string;
  inlines: Inline[];
  plainText: string;
};

type TableCell = { inlines: Inline[]; plainText: string };

type TableBlock = {
  id: string;
  anchorId: string;
  type: "table";
  role?: string;
  rows: TableCell[][];
  plainText: string;
};

type Block = HeadingBlock | ParagraphBlock | TableBlock;

type DocumentAst = {
  version: 1;
  blocks: Block[];
};

const isDocumentAst = (val: unknown): val is DocumentAst =>
  typeof val === "object" &&
  val !== null &&
  "blocks" in val &&
  // SAFETY: `"blocks" in val` narrows val to object with
  // the blocks key; Record cast reads it for Array.isArray.
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  Array.isArray((val as Record<string, unknown>).blocks);

type Decision = {
  caseNumber: string;
  court: string;
  language: string;
  fulltext: string | null;
  documentAst?: unknown;
  metadata?: Record<string, unknown> | null;
};

type DecisionTextProps = {
  decision: Decision;
  /** Map from anchorId to section info (cssVar + headingId). */
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
};

// ── Inline renderer ───────────────────────────────────────

const renderInline = (node: Inline, key: number): ReactNode => {
  if (node.type === "text") {
    if (node.anonymized) {
      return (
        <span
          className="bg-muted/60 text-muted-foreground rounded-sm px-0.5"
          key={key}
        >
          [{node.text}]
        </span>
      );
    }
    return node.text;
  }
  if (node.type === "line-break") {
    return <br key={key} />;
  }
  if (node.type === "bold") {
    return (
      <strong className="font-[650]" key={key}>
        {node.children.map(renderInline)}
      </strong>
    );
  }
  if (node.type === "italic") {
    return (
      <em className="italic" key={key}>
        {node.children.map(renderInline)}
      </em>
    );
  }
  if (node.type === "link") {
    return (
      <a
        className="decoration-border underline underline-offset-2 hover:decoration-current"
        href={node.href}
        key={key}
        rel="noopener noreferrer"
        target="_blank"
      >
        {node.children.map(renderInline)}
      </a>
    );
  }
  return null;
};

const InlineContent = ({ inlines }: { inlines: Inline[] }) => (
  <>{inlines.map(renderInline)}</>
);

// ── Block renderers ───────────────────────────────────────

const BlockRenderer = ({ block }: { block: Block }) => {
  if (block.type === "heading") {
    const Tag = `h${block.level}` as const;
    return (
      <Tag
        className={cn(
          "scroll-mt-[var(--reader-anchor-offset)]",
          block.level === 1 &&
            "mt-4 mb-5 text-center text-lg leading-tight font-bold tracking-widest first:mt-0",
          block.level === 2 &&
            "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-[0.95rem] leading-snug font-bold tracking-wider",
          block.level === 3 &&
            "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm leading-snug font-semibold",
        )}
        id={block.anchorId}
      >
        <InlineContent inlines={block.inlines} />
      </Tag>
    );
  }

  if (block.type === "paragraph") {
    return (
      <p
        className={cn(
          "mb-[var(--reader-paragraph-gap)] scroll-mt-[var(--reader-anchor-offset)] last:mb-0",
          !block.role && "reader-justify",
          block.role === "holding" && "reader-justify font-[520]",
          block.role === "case-number" &&
            "text-muted-foreground mb-2 text-right font-sans text-[0.95rem]",
          block.role === "closing" && "mt-8 text-center",
          block.role === "signature" &&
            "reader-signature text-muted-foreground mt-1 text-right",
        )}
        id={block.anchorId}
      >
        <InlineContent inlines={block.inlines} />
      </p>
    );
  }

  if (block.type === "table") {
    if (block.role === "related-proceedings") {
      return null;
    }

    return (
      <table
        className="my-4 w-full border-collapse scroll-mt-[var(--reader-anchor-offset)] font-sans text-[0.88rem]"
        id={block.anchorId}
      >
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  className="border-border/55 border-b px-3 py-1 align-top last:border-b-0"
                  key={ci}
                >
                  <InlineContent inlines={cell.inlines} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return null;
};

// ── Fulltext fallback ─────────────────────────────────────

const FulltextFallback = ({ text }: { text: string }) => {
  const paragraphs = text.split(/\n{2,}/);

  return (
    <>
      {paragraphs.map((p, i) => (
        <p className="mb-[var(--reader-paragraph-gap)] last:mb-0" key={i}>
          {p}
        </p>
      ))}
    </>
  );
};

// ── Holding zone grouping ─────────────────────────────────

const isHoldingBlock = (b: Block): boolean =>
  b.type === "paragraph" && b.role === "holding";

const renderBlocksWithHoldingZone = (
  blocks: Block[],
  sectionMap?: Map<string, { cssVar: string; headingId: string }>,
): ReactNode[] => {
  const result: ReactNode[] = [];

  // Group consecutive blocks by heading ID for continuous lines.
  // Same category but different heading = separate groups.
  type Group = { cssVar: string | null; headingId: string | null; blocks: Block[] };
  const groups: Group[] = [];

  for (const block of blocks) {
    const info = sectionMap?.get(block.anchorId) ?? null;
    const cssVar = info?.cssVar ?? null;
    const headingId = info?.headingId ?? null;
    const last = groups.at(-1);
    if (last && last.headingId === headingId && last.cssVar === cssVar) {
      last.blocks.push(block);
    } else {
      groups.push({ cssVar, headingId, blocks: [block] });
    }
  }

  for (const group of groups) {
    const hasPrev = result.length > 0;
    const borderStyle = group.cssVar
      ? { borderLeftColor: `color-mix(in srgb, var(${group.cssVar}) 25%, transparent)` }
      : undefined;

    // Render all blocks in source order, wrapping in a section div
    result.push(
      <div
        className={cn(
          "border-l-2 pl-3",
          !group.cssVar && "border-l-transparent",
          hasPrev && "mt-1.5",
        )}
        key={`section-${group.blocks.at(0)?.id}`}
        style={borderStyle}
      >
        {group.blocks.map((b) =>
          isHoldingBlock(b) ? (
            <div className="font-[520]" key={b.id}>
              <BlockRenderer block={b} />
            </div>
          ) : (
            <BlockRenderer block={b} key={b.id} />
          ),
        )}
      </div>,
    );
  }

  return result;
};

// ── Editorial supplement (abstract, legal sentence) ───────

const EditorialSupplement = ({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) => {
  const t = useTranslations();
  const abstract =
    typeof metadata.abstract === "string" ? metadata.abstract : null;
  const legalSentence =
    typeof metadata.legalSentence === "string" ? metadata.legalSentence : null;

  if (!abstract && !legalSentence) {
    return null;
  }

  return (
    <div className="bg-muted/30 border-border/50 mb-8 rounded-lg border px-5 py-4 font-sans text-[0.88rem] leading-relaxed">
      {legalSentence && (
        <section>
          <h4 className="text-muted-foreground mb-2 text-[0.75rem] font-semibold tracking-wide uppercase">
            {t("caseLaw.viewer.legalSentence")}
          </h4>
          <p className="reader-justify">{legalSentence}</p>
        </section>
      )}
      {abstract && (
        <section className={legalSentence ? "mt-4" : ""}>
          <h4 className="text-muted-foreground mb-2 text-[0.75rem] font-semibold tracking-wide uppercase">
            {t("caseLaw.viewer.abstract")}
          </h4>
          <p className="text-muted-foreground/80 reader-justify">{abstract}</p>
        </section>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────

export const DecisionText = ({
  decision,
  sectionMap,
}: DecisionTextProps) => {
  const t = useTranslations();

  const rawAst = decision.documentAst;
  const ast: DocumentAst | null = (() => {
    if (rawAst === null || rawAst === undefined) {
      return null;
    }
    if (typeof rawAst === "string") {
      const parsed: unknown = JSON.parse(rawAst);
      return isDocumentAst(parsed) ? parsed : null;
    }
    return isDocumentAst(rawAst) ? rawAst : null;
  })();

  if (ast && ast.blocks.length > 0) {
    // Use the full case reference from the AST (e.g.
    // "6 Tdo 647/2017-I") if available, otherwise
    // fall back to the DB caseNumber.
    const caseNumberBlock = ast.blocks.find(
      (b) => b.type === "paragraph" && b.role === "case-number",
    );
    const displayRef = caseNumberBlock?.plainText ?? decision.caseNumber;

    return (
      <article
        className="text-card-foreground text-left"
        lang={decision.language}
        style={{
          fontFamily: "var(--reader-body-font)",
          fontSize: "var(--reader-body-size)",
          lineHeight: "var(--reader-body-line-height)",
        }}
      >
        <p className="text-muted-foreground mb-4 text-right font-sans text-xs italic">
          {decision.court}, {displayRef}
        </p>
        {decision.metadata !== null && decision.metadata !== undefined && (
          <EditorialSupplement metadata={decision.metadata} />
        )}
        {renderBlocksWithHoldingZone(
          ast.blocks.filter(
            (b) =>
              !(b.type === "paragraph" && b.role === "case-number") &&
              !(
                b.type === "heading" &&
                b.plainText.toUpperCase() === "JMÉNEM REPUBLIKY"
              ),
          ),
          sectionMap,
        )}
      </article>
    );
  }

  if (decision.fulltext) {
    return (
      <article
        className="text-card-foreground text-left"
        lang={decision.language}
        style={{
          fontFamily: "var(--reader-body-font)",
          fontSize: "var(--reader-body-size)",
          lineHeight: "var(--reader-body-line-height)",
        }}
      >
        {decision.metadata !== null && decision.metadata !== undefined && (
          <EditorialSupplement metadata={decision.metadata} />
        )}
        <FulltextFallback text={decision.fulltext} />
      </article>
    );
  }

  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-muted-foreground text-sm">{t("caseLaw.emptyState")}</p>
    </div>
  );
};
