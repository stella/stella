import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  CONDITIONAL_KINDS,
  DirectiveLabel,
  HighlightedText,
} from "@/routes/_protected.knowledge/-components/paragraph-rendering";
import type { BlockDirectiveKind } from "@/routes/_protected.knowledge/-components/paragraph-rendering";
import { templatePreviewOptions } from "@/routes/_protected.knowledge/-queries";

// ── Types ────────────────────────────────────────────────

type ParagraphSource = "header" | "body" | "footer";

type ExtractedParagraph = {
  index: number;
  text: string;
  style?: string | undefined;
  source?: ParagraphSource | undefined;
  bold?: boolean | undefined;
  fontSize?: number | undefined;
  alignment?: "left" | "center" | "right" | "both" | undefined;
  isDirective?: boolean | undefined;
  directiveKind?: BlockDirectiveKind | undefined;
  directiveExpression?: string | undefined;
};

type StructureError = {
  message: string;
  paragraphIndex: number;
  directive: string;
};

// ── Nesting + block spans ────────────────────────────────

const MAX_DEPTH = 5;

type BlockSpan = {
  startIdx: number;
  endIdx: number;
  depth: number;
  isConditional: boolean;
};

const OPENERS = new Set<BlockDirectiveKind>(["if", "each"]);
const CLOSERS = new Set<BlockDirectiveKind>(["endif", "endeach"]);

/**
 * Compute per-paragraph depths and block spans (for
 * vertical connector lines).
 */
const computeLayout = (
  paragraphs: ExtractedParagraph[],
): { depths: number[]; blockSpans: BlockSpan[] } => {
  const depths: number[] = [];
  const blockSpans: BlockSpan[] = [];
  const stack: { idx: number; depth: number; conditional: boolean }[] = [];
  let depth = 0;

  for (const [i, p] of paragraphs.entries()) {
    if (!p.isDirective) {
      depths.push(depth);
      continue;
    }

    const kind = p.directiveKind;

    if (kind && OPENERS.has(kind)) {
      depths.push(depth);
      stack.push({
        idx: i,
        depth,
        conditional: kind === "if",
      });
      depth = Math.min(depth + 1, MAX_DEPTH);
    } else if (kind === "elseif" || kind === "else") {
      depths.push(Math.max(depth - 1, 0));
    } else if (kind && CLOSERS.has(kind)) {
      depth = Math.max(depth - 1, 0);
      depths.push(depth);
      const open = stack.pop();
      if (open) {
        blockSpans.push({
          startIdx: open.idx,
          endIdx: i,
          depth: open.depth,
          isConditional: open.conditional,
        });
      }
    } else {
      depths.push(depth);
    }
  }

  return { depths, blockSpans };
};

/**
 * For each paragraph index, collect which block-span
 * depths have a vertical line running through it
 * (strictly between opener and closer, exclusive).
 */
const computeActiveLines = (
  blockSpans: BlockSpan[],
): Map<number, BlockSpan[]> => {
  const map = new Map<number, BlockSpan[]>();
  for (const span of blockSpans) {
    for (let i = span.startIdx + 1; i < span.endIdx; i++) {
      const list = map.get(i);
      if (list) {
        list.push(span);
      } else {
        map.set(i, [span]);
      }
    }
  }
  return map;
};

// ── Font size helpers ────────────────────────────────────

/** Convert DOCX half-points to a CSS-friendly rem value. */
const fontSizeToRem = (halfPoints: number | undefined): string | undefined => {
  if (halfPoints === undefined || halfPoints === 0) {
    return undefined;
  }
  // DOCX stores font size in half-points (24 = 12pt).
  // Base UI text-sm is ~14px ≈ 10.5pt ≈ 21 half-points.
  // Only deviate when the document uses non-default sizes.
  if (halfPoints <= 18) {
    return "0.75rem"; // ~12px, small
  }
  if (halfPoints <= 22) {
    return undefined; // ~11pt, close to default
  }
  if (halfPoints <= 28) {
    return "1rem"; // ~14pt
  }
  if (halfPoints <= 36) {
    return "1.125rem"; // ~18pt
  }
  return "1.25rem"; // 20pt+
};

const ALIGNMENT_CLASS: Record<string, string> = {
  center: "text-center",
  right: "text-right",
  both: "text-justify",
};

// ── Sub-components ───────────────────────────────────────

const LINE_OFFSET = 16; // px per depth level

/** Thin vertical connector lines for active block spans. */
const ConnectorLines = ({
  activeSpans,
}: {
  activeSpans: readonly BlockSpan[];
}) => (
  <>
    {activeSpans.map((span) => (
      <div
        className={`absolute top-0 bottom-0 w-px ${
          span.isConditional
            ? "bg-foreground/30 dark:bg-foreground-strong-muted"
            : "bg-success/30 dark:bg-success/50"
        }`}
        key={`${span.startIdx}-${span.depth}`}
        style={{ insetInlineStart: span.depth * LINE_OFFSET + 7 }}
      />
    ))}
  </>
);

const PreviewParagraph = ({
  paragraph,
  depth,
  error,
  activeSpans,
}: {
  paragraph: ExtractedParagraph;
  depth: number;
  error?: StructureError | undefined;
  activeSpans: BlockSpan[];
}) => {
  const isHeading = paragraph.style?.startsWith("Heading");
  const sizeRem = fontSizeToRem(paragraph.fontSize);
  const alignClass = paragraph.alignment
    ? ALIGNMENT_CLASS[paragraph.alignment]
    : undefined;

  if (paragraph.isDirective && paragraph.directiveKind) {
    const isConditional = CONDITIONAL_KINDS.has(paragraph.directiveKind);

    return (
      <div className="relative">
        <ConnectorLines activeSpans={activeSpans} />
        <div
          className={`rounded-sm border-s-[3px] py-1.5 ps-3 pe-2 ${
            isConditional
              ? "border-foreground-disabled bg-accent/50 dark:border-foreground-disabled dark:bg-accent/30"
              : "border-success/40 bg-success/10 dark:border-success/40 dark:bg-success/10"
          }`}
          style={{ marginInlineStart: depth * LINE_OFFSET }}
        >
          <DirectiveLabel
            expression={paragraph.directiveExpression ?? ""}
            kind={paragraph.directiveKind}
          />
          {error && <ErrorIndicator error={error} />}
        </div>
      </div>
    );
  }

  if (!paragraph.text.trim()) {
    return (
      <div
        className="relative py-1"
        style={{ paddingInlineStart: depth * LINE_OFFSET }}
      >
        <ConnectorLines activeSpans={activeSpans} />
      </div>
    );
  }

  const fontClasses = [
    "leading-relaxed",
    isHeading || paragraph.bold ? "font-semibold" : "",
    alignClass ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const fontStyle: React.CSSProperties = {};
  if (sizeRem) {
    fontStyle.fontSize = sizeRem;
  }

  return (
    <div className="relative py-1" style={{ paddingLeft: depth * LINE_OFFSET }}>
      <ConnectorLines activeSpans={activeSpans} />
      <p className={fontClasses} style={fontStyle}>
        <HighlightedText text={paragraph.text} />
      </p>
      {error && <ErrorIndicator error={error} />}
    </div>
  );
};

const ErrorIndicator = ({ error }: { error: StructureError }) => (
  <p className="text-destructive mt-1 flex items-center gap-1 text-xs">
    <AlertTriangleIcon className="size-3 shrink-0" />
    {error.message}
  </p>
);

/** Subtle divider between header/body/footer sections. */
const SectionDivider = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 pt-2 pb-1">
    <div className="bg-border h-px flex-1" />
    <span className="text-muted-foreground text-[10px] tracking-wider uppercase">
      {label}
    </span>
    <div className="bg-border h-px flex-1" />
  </div>
);

// ── Main component ───────────────────────────────────────

const protectedRouteApi = getRouteApi("/_protected");

export const TemplatePreview = ({ templateId }: { templateId: string }) => {
  const t = useTranslations("templates");
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data, isLoading, isError } = useQuery(
    templatePreviewOptions(activeOrganizationId, templateId),
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("discovering")}</p>
      </div>
    );
  }

  if (isError || !data || data instanceof Response || !("paragraphs" in data)) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("previewFailed")}</p>
      </div>
    );
  }

  const { paragraphs, structureErrors } = data;

  if (paragraphs.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("previewEmpty")}</p>
      </div>
    );
  }

  const { depths, blockSpans } = computeLayout(paragraphs);
  const activeLines = computeActiveLines(blockSpans);
  const errorsByIndex = new Map(
    structureErrors.map((e) => [e.paragraphIndex, e]),
  );

  // Detect whether the response contains multiple sections
  const sources = new Set(paragraphs.map((p) => p.source).filter(Boolean));
  const hasMultipleSections = sources.size > 1;

  return (
    <div className="space-y-0.5 py-2">
      {paragraphs.map((p, i) => {
        // Show section divider at the first paragraph of
        // each new source section (only when mixed sources)
        const prevSource = i > 0 ? paragraphs[i - 1]?.source : undefined;
        const source = p.source;
        const showDivider =
          hasMultipleSections && source !== undefined && source !== prevSource;

        const sectionLabel = (() => {
          if (source === "header") {
            return t("previewSectionHeader");
          }
          if (source === "footer") {
            return t("previewSectionFooter");
          }
          return t("previewSectionBody");
        })();

        return (
          <div key={p.index}>
            {showDivider && <SectionDivider label={sectionLabel} />}
            <PreviewParagraph
              activeSpans={activeLines.get(i) ?? []}
              depth={depths[i] ?? 0}
              error={errorsByIndex.get(p.index)}
              paragraph={p}
            />
          </div>
        );
      })}
    </div>
  );
};
