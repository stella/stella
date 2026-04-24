import { Fragment, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type { Block, DocumentAst, Inline } from "@stella/case-law/document-ast";
import { parseDocumentAst } from "@stella/case-law/document-ast";
import { cn } from "@stella/ui/lib/utils";

import { sanitizeHref } from "@/lib/sanitize-href";

import type { SearchMatchRange, SearchPiece } from "./decision-search";
import { buildSearchResults } from "./decision-search";
import "./reader.css";

type Decision = {
  caseNumber: string;
  court: string;
  language: string;
  fulltext: string | null;
  documentAst?: unknown;
  metadata?: Record<string, unknown> | null;
};

type DecisionTextProps = {
  activeMatchIndex: number;
  decision: Decision;
  onMatchCountChange?: ((count: number) => void) | undefined;
  searchQuery: string;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
};

type HighlightContext = {
  activeMatchIndex: number;
  pieceId: string;
  ranges: SearchMatchRange[];
};

type OffsetRef = { value: number };
type SynchronousNode =
  | React.JSX.Element
  | ReactNode[]
  | Iterable<SynchronousNode>
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined;

const SUPPLEMENT_LEGAL_SENTENCE_ID = "supplement-legal-sentence";
const SUPPLEMENT_ABSTRACT_ID = "supplement-abstract";
const DECISION_REFERENCE_ID = "decision-reference";

const isHoldingBlock = (block: Block): boolean =>
  block.type === "paragraph" && block.role === "holding";

/**
 * Flatten `inlines` into the same character sequence that
 * `renderInline` walks through when it tracks offsets. Mirrors
 * the renderer: text nodes contribute verbatim, line-breaks are
 * a single "\n", bold/italic/link children are recursed into.
 *
 * Search pieces must come from this — NOT from `block.plainText`
 * — because the API pipeline collapses spaced-letter runs in
 * `plainText` (for DB FTS) while leaving inline text untouched.
 * Using `plainText` would misalign match offsets from the inline
 * offsets the highlight renderer uses.
 */
const inlinesToPlainText = (inlines: readonly Inline[]): string => {
  let out = "";
  for (const node of inlines) {
    if (node.type === "text") {
      out += node.text;
    } else if (node.type === "line-break") {
      out += "\n";
    } else {
      out += inlinesToPlainText(node.children);
    }
  }
  return out;
};

/**
 * Source-level placeholder strings emitted by courts when an
 * editorial field is empty. We hide these at render time and
 * must also exclude them from search pieces so the find bar
 * doesn't report matches with no visible target.
 */
const SUPPLEMENT_PLACEHOLDER_RE =
  /\b(?:není k dispozici|nie je k dispozícii|niedostępn[ay])\b/iu;

const cleanSupplement = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || SUPPLEMENT_PLACEHOLDER_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const getTableCellPieceId = ({
  blockId,
  columnIndex,
  rowIndex,
}: {
  blockId: string;
  columnIndex: number;
  rowIndex: number;
}): string => `table:${blockId}:${rowIndex}:${columnIndex}`;

const getVisibleBlocks = (ast: DocumentAst | null): Block[] => {
  if (!ast) {
    return [];
  }

  return ast.blocks.filter(
    (block) =>
      !(block.type === "paragraph" && block.role === "case-number") &&
      !(
        block.type === "heading" &&
        block.plainText.toUpperCase() === "JMÉNEM REPUBLIKY"
      ) &&
      !(block.type === "table" && block.role === "related-proceedings"),
  );
};

const renderTextSegment = ({
  activeMatchIndex,
  anonymized,
  pieceId,
  ranges,
  segmentStart,
  text,
}: {
  activeMatchIndex: number;
  anonymized?: boolean | undefined;
  pieceId: string;
  ranges: SearchMatchRange[];
  segmentStart: number;
  text: string;
}): SynchronousNode => {
  const segmentEnd = segmentStart + text.length;
  const relevantRanges = ranges.filter(
    (range) => range.end > segmentStart && range.start < segmentEnd,
  );

  if (relevantRanges.length === 0) {
    if (anonymized) {
      return (
        <span className="bg-muted/60 text-muted-foreground rounded-sm px-0.5">
          [{text}]
        </span>
      );
    }
    return text;
  }

  const children: ReactNode[] = [];
  let cursor = segmentStart;

  for (const range of relevantRanges) {
    const localStart = Math.max(range.start - segmentStart, 0);
    const localEnd = Math.min(range.end - segmentStart, text.length);

    if (localStart > cursor - segmentStart) {
      children.push(text.slice(cursor - segmentStart, localStart));
    }

    const isActive = range.matchIndex === activeMatchIndex;
    children.push(
      <mark
        className={cn(
          "text-inherit",
          isActive
            ? "bg-primary/40 text-primary-foreground ring-primary ring-1"
            : "bg-primary/22",
        )}
        data-reader-match-index={range.matchIndex}
        key={`${pieceId}-${range.matchIndex}-${localStart}`}
      >
        {text.slice(localStart, localEnd)}
      </mark>,
    );
    cursor = segmentStart + localEnd;
  }

  if (cursor < segmentEnd) {
    children.push(text.slice(cursor - segmentStart));
  }

  if (anonymized) {
    return (
      <span className="bg-muted/60 text-muted-foreground rounded-sm px-0.5">
        [{children}]
      </span>
    );
  }

  return children;
};

const renderInline = ({
  context,
  key,
  node,
  offset,
}: {
  context: HighlightContext;
  key: number;
  node: Inline;
  offset: OffsetRef;
}): SynchronousNode => {
  if (node.type === "text") {
    const segmentStart = offset.value;
    offset.value += node.text.length;

    return (
      <Fragment key={key}>
        {renderTextSegment({
          activeMatchIndex: context.activeMatchIndex,
          anonymized: node.anonymized,
          pieceId: context.pieceId,
          ranges: context.ranges,
          segmentStart,
          text: node.text,
        })}
      </Fragment>
    );
  }

  if (node.type === "line-break") {
    // SAFETY: `plainText` is produced by `inlinesToPlainText`, which encodes each
    // `line-break` node as a single "\n". The renderer must advance by the same
    // one-character offset so search highlight ranges stay aligned with `plainText`.
    offset.value += 1;
    return <br key={key} />;
  }

  if (node.type === "bold") {
    return (
      <strong className="font-[650]" key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </strong>
    );
  }

  if (node.type === "italic") {
    return (
      <em className="italic" key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </em>
    );
  }

  if (node.type === "link") {
    const safeHref = sanitizeHref(node.href);
    if (safeHref) {
      return (
        <a
          className="decoration-border underline underline-offset-2 hover:decoration-current"
          href={safeHref}
          key={key}
          rel="noopener noreferrer"
          target="_blank"
        >
          {renderInlineChildren({ children: node.children, context, offset })}
        </a>
      );
    }

    // Unsanitized href: render children as plain text
    return (
      <span key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </span>
    );
  }

  return null;
};

const renderInlineChildren = ({
  children,
  context,
  offset,
}: {
  children: Inline[];
  context: HighlightContext;
  offset: OffsetRef;
}): SynchronousNode[] => {
  const renderedChildren: SynchronousNode[] = [];

  for (const [index, child] of children.entries()) {
    renderedChildren.push(
      renderInline({ context, key: index, node: child, offset }),
    );
  }

  return renderedChildren;
};

const InlineContent = ({
  activeMatchIndex,
  inlines,
  pieceId,
  ranges,
}: {
  activeMatchIndex: number;
  inlines: Inline[];
  pieceId: string;
  ranges: SearchMatchRange[];
}) => {
  const offset: OffsetRef = { value: 0 };
  const context: HighlightContext = {
    pieceId,
    ranges,
    activeMatchIndex,
  };

  return <>{renderInlineChildren({ children: inlines, context, offset })}</>;
};

const HighlightedText = ({
  activeMatchIndex,
  className,
  pieceId,
  ranges,
  text,
}: {
  activeMatchIndex: number;
  className?: string | undefined;
  pieceId: string;
  ranges: SearchMatchRange[];
  text: string;
}) => (
  <span className={className}>
    {renderTextSegment({
      activeMatchIndex,
      pieceId,
      ranges,
      segmentStart: 0,
      text,
    })}
  </span>
);

const EditorialSupplement = ({
  activeMatchIndex,
  metadata,
  rangesByPieceId,
}: {
  activeMatchIndex: number;
  metadata: Record<string, unknown>;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
}) => {
  const t = useTranslations();
  const abstract = cleanSupplement(metadata.abstract);
  const legalSentence = cleanSupplement(metadata.legalSentence);

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
          <p className="reader-justify">
            <HighlightedText
              activeMatchIndex={activeMatchIndex}
              pieceId={SUPPLEMENT_LEGAL_SENTENCE_ID}
              ranges={rangesByPieceId[SUPPLEMENT_LEGAL_SENTENCE_ID] ?? []}
              text={legalSentence}
            />
          </p>
        </section>
      )}
      {abstract && (
        <section className={legalSentence ? "mt-4" : ""}>
          <h4 className="text-muted-foreground mb-2 text-[0.75rem] font-semibold tracking-wide uppercase">
            {t("caseLaw.viewer.abstract")}
          </h4>
          <p className="text-muted-foreground/80 reader-justify">
            <HighlightedText
              activeMatchIndex={activeMatchIndex}
              pieceId={SUPPLEMENT_ABSTRACT_ID}
              ranges={rangesByPieceId[SUPPLEMENT_ABSTRACT_ID] ?? []}
              text={abstract}
            />
          </p>
        </section>
      )}
    </div>
  );
};

const BlockRenderer = ({
  activeMatchIndex,
  block,
  rangesByPieceId,
}: {
  activeMatchIndex: number;
  block: Block;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
}) => {
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
        <InlineContent
          activeMatchIndex={activeMatchIndex}
          inlines={block.inlines}
          pieceId={block.id}
          ranges={rangesByPieceId[block.id] ?? []}
        />
      </Tag>
    );
  }

  if (block.type === "paragraph") {
    // Short standalone roman numerals (I, II, III …) that the
    // parser emitted as paragraphs are section dividers; centre
    // them like level-3 headings instead of bleeding into the
    // body copy.
    const isRomanNumeralDivider = /^[IVX]+\.?$/u.test(block.plainText.trim());
    // Non-body roles (case number, closing formula, signature)
    // need their own alignment; every other paragraph — including
    // intro, argumentation and unroled body text — defaults to
    // justified reading layout.
    const nonJustifiedRoles = new Set(["case-number", "closing", "signature"]);
    const shouldJustify =
      !isRomanNumeralDivider &&
      (block.role === undefined || !nonJustifiedRoles.has(block.role));
    return (
      <p
        className={cn(
          "mb-[var(--reader-paragraph-gap)] scroll-mt-[var(--reader-anchor-offset)] last:mb-0",
          shouldJustify && "reader-justify",
          block.role === "holding" && "font-[520]",
          isRomanNumeralDivider &&
            "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm font-semibold",
          block.role === "case-number" &&
            "text-muted-foreground mb-2 text-end font-sans text-[0.95rem]",
          block.role === "closing" && "mt-8 text-center",
          block.role === "signature" &&
            "reader-signature text-muted-foreground mt-1 text-end",
        )}
        id={block.anchorId}
      >
        <InlineContent
          activeMatchIndex={activeMatchIndex}
          inlines={block.inlines}
          pieceId={block.id}
          ranges={rangesByPieceId[block.id] ?? []}
        />
      </p>
    );
  }

  return (
    <table
      className="my-4 w-full border-collapse scroll-mt-[var(--reader-anchor-offset)] font-sans text-[0.88rem]"
      id={block.anchorId}
    >
      <tbody>
        {block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, columnIndex) => {
              const pieceId = getTableCellPieceId({
                blockId: block.id,
                rowIndex,
                columnIndex,
              });

              return (
                <td
                  className="border-border/55 border-b px-3 py-1 align-top last:border-b-0"
                  key={pieceId}
                >
                  <InlineContent
                    activeMatchIndex={activeMatchIndex}
                    inlines={cell.inlines}
                    pieceId={pieceId}
                    ranges={rangesByPieceId[pieceId] ?? []}
                  />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const FulltextFallback = ({
  activeMatchIndex,
  rangesByPieceId,
  text,
}: {
  activeMatchIndex: number;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  text: string;
}) => {
  const paragraphs = text.split(/\n{2,}/);

  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const pieceId = `fulltext:${index}`;

        return (
          <p
            className="mb-[var(--reader-paragraph-gap)] last:mb-0"
            key={pieceId}
          >
            <HighlightedText
              activeMatchIndex={activeMatchIndex}
              pieceId={pieceId}
              ranges={rangesByPieceId[pieceId] ?? []}
              text={paragraph}
            />
          </p>
        );
      })}
    </>
  );
};

const renderBlocksWithHoldingZone = ({
  activeMatchIndex,
  blocks,
  rangesByPieceId,
  sectionMap,
}: {
  activeMatchIndex: number;
  blocks: Block[];
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
}): ReactNode[] => {
  const result: ReactNode[] = [];

  // Group consecutive blocks by heading ID for continuous lines.
  // Same category but different heading = separate groups.
  type Group = {
    cssVar: string | null;
    headingId: string | null;
    blocks: Block[];
  };

  const groups: Group[] = [];

  for (const block of blocks) {
    const info = sectionMap?.get(block.anchorId) ?? null;
    const cssVar = info?.cssVar ?? null;
    const headingId = info?.headingId ?? null;
    const lastGroup = groups.at(-1);

    if (
      lastGroup &&
      lastGroup.headingId === headingId &&
      lastGroup.cssVar === cssVar
    ) {
      lastGroup.blocks.push(block);
      continue;
    }

    groups.push({ blocks: [block], cssVar, headingId });
  }

  for (const group of groups) {
    const hasPreviousGroup = result.length > 0;
    const borderStyle = group.cssVar
      ? {
          borderInlineStartColor: `color-mix(in srgb, var(${group.cssVar}) 25%, transparent)`,
        }
      : undefined;

    result.push(
      <div
        className={cn(
          "border-s-2 ps-3",
          !group.cssVar && "border-s-transparent",
          hasPreviousGroup && "mt-1.5",
        )}
        key={`section-${group.blocks.at(0)?.id}`}
        style={borderStyle}
      >
        {group.blocks.map((block) =>
          isHoldingBlock(block) ? (
            <div className="font-[520]" key={block.id}>
              <BlockRenderer
                activeMatchIndex={activeMatchIndex}
                block={block}
                rangesByPieceId={rangesByPieceId}
              />
            </div>
          ) : (
            <BlockRenderer
              activeMatchIndex={activeMatchIndex}
              block={block}
              key={block.id}
              rangesByPieceId={rangesByPieceId}
            />
          ),
        )}
      </div>,
    );
  }

  return result;
};

export const DecisionText = ({
  activeMatchIndex,
  decision,
  onMatchCountChange,
  searchQuery,
  sectionMap,
}: DecisionTextProps) => {
  const t = useTranslations();

  const ast = useMemo(
    () => parseDocumentAst(decision.documentAst),
    [decision.documentAst],
  );
  const visibleBlocks = useMemo(() => getVisibleBlocks(ast), [ast]);
  const articleRef = useRef<HTMLElement>(null);

  const caseNumberBlock = ast?.blocks.find(
    (block) => block.type === "paragraph" && block.role === "case-number",
  );
  const displayRef = caseNumberBlock?.plainText ?? decision.caseNumber;

  const searchPieces = useMemo<SearchPiece[]>(() => {
    // If the render falls through to the empty-state message
    // (no visible blocks AND no fulltext) nothing gets drawn on
    // the page, so indexing the reference + supplement would
    // surface matches with no scroll target. Keep pieces aligned
    // with what actually renders.
    const hasRenderableBody =
      visibleBlocks.length > 0 ||
      (decision.fulltext !== null && decision.fulltext !== "");
    if (!hasRenderableBody) {
      return [];
    }

    const pieces: SearchPiece[] = [
      {
        id: DECISION_REFERENCE_ID,
        text: `${decision.court}, ${displayRef}`,
      },
    ];

    const metadata = decision.metadata;
    if (metadata !== null && metadata !== undefined) {
      // Skip placeholder boilerplate ("není k dispozici" etc.)
      // so the counter can't report matches in text the
      // supplement renderer hides.
      const legalSentence = cleanSupplement(metadata.legalSentence);
      const abstract = cleanSupplement(metadata.abstract);

      if (legalSentence) {
        pieces.push({
          id: SUPPLEMENT_LEGAL_SENTENCE_ID,
          text: legalSentence,
        });
      }

      if (abstract) {
        pieces.push({
          id: SUPPLEMENT_ABSTRACT_ID,
          text: abstract,
        });
      }
    }

    if (visibleBlocks.length > 0) {
      for (const block of visibleBlocks) {
        if (block.type === "table") {
          for (const [rowIndex, row] of block.rows.entries()) {
            for (const [columnIndex, cell] of row.entries()) {
              pieces.push({
                id: getTableCellPieceId({
                  blockId: block.id,
                  rowIndex,
                  columnIndex,
                }),
                text: inlinesToPlainText(cell.inlines),
              });
            }
          }
          continue;
        }

        pieces.push({
          id: block.id,
          text: inlinesToPlainText(block.inlines),
        });
      }
    } else if (decision.fulltext) {
      for (const [index, paragraph] of decision.fulltext
        .split(/\n{2,}/)
        .entries()) {
        pieces.push({
          id: `fulltext:${index}`,
          text: paragraph,
        });
      }
    }

    return pieces;
  }, [
    decision.court,
    decision.fulltext,
    decision.metadata,
    displayRef,
    visibleBlocks,
  ]);

  const searchResults = useMemo(
    () =>
      buildSearchResults({
        pieces: searchPieces,
        query: searchQuery,
      }),
    [searchPieces, searchQuery],
  );

  useEffect(() => {
    onMatchCountChange?.(searchResults.matchCount);
  }, [onMatchCountChange, searchResults.matchCount]);

  useEffect(() => {
    if (searchQuery.trim().length === 0 || searchResults.matchCount === 0) {
      return;
    }

    const activeMatch = articleRef.current?.querySelector<HTMLElement>(
      `[data-reader-match-index="${activeMatchIndex}"]`,
    );

    activeMatch?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, [activeMatchIndex, searchQuery, searchResults.matchCount]);

  if (visibleBlocks.length > 0) {
    return (
      <article
        className="text-card-foreground text-start"
        lang={decision.language}
        ref={articleRef}
        style={{
          fontFamily: "var(--reader-body-font)",
          fontSize: "var(--reader-body-size)",
          lineHeight: "var(--reader-body-line-height)",
        }}
      >
        <p className="text-muted-foreground mb-4 text-end font-sans text-xs italic">
          <HighlightedText
            activeMatchIndex={activeMatchIndex}
            pieceId={DECISION_REFERENCE_ID}
            ranges={searchResults.rangesByPieceId[DECISION_REFERENCE_ID] ?? []}
            text={`${decision.court}, ${displayRef}`}
          />
        </p>
        {decision.metadata !== null && decision.metadata !== undefined && (
          <EditorialSupplement
            activeMatchIndex={activeMatchIndex}
            metadata={decision.metadata}
            rangesByPieceId={searchResults.rangesByPieceId}
          />
        )}
        {renderBlocksWithHoldingZone({
          activeMatchIndex,
          blocks: visibleBlocks,
          rangesByPieceId: searchResults.rangesByPieceId,
          sectionMap,
        })}
      </article>
    );
  }

  if (decision.fulltext) {
    return (
      <article
        className="text-card-foreground text-start"
        lang={decision.language}
        ref={articleRef}
        style={{
          fontFamily: "var(--reader-body-font)",
          fontSize: "var(--reader-body-size)",
          lineHeight: "var(--reader-body-line-height)",
        }}
      >
        <p className="text-muted-foreground mb-4 text-end font-sans text-xs italic">
          <HighlightedText
            activeMatchIndex={activeMatchIndex}
            pieceId={DECISION_REFERENCE_ID}
            ranges={searchResults.rangesByPieceId[DECISION_REFERENCE_ID] ?? []}
            text={`${decision.court}, ${displayRef}`}
          />
        </p>
        {decision.metadata !== null && decision.metadata !== undefined && (
          <EditorialSupplement
            activeMatchIndex={activeMatchIndex}
            metadata={decision.metadata}
            rangesByPieceId={searchResults.rangesByPieceId}
          />
        )}
        <FulltextFallback
          activeMatchIndex={activeMatchIndex}
          rangesByPieceId={searchResults.rangesByPieceId}
          text={decision.fulltext}
        />
      </article>
    );
  }

  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-muted-foreground text-sm">{t("caseLaw.emptyState")}</p>
    </div>
  );
};
