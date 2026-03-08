import { useCallback, useEffect, useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import {
  CONDITIONAL_KINDS,
  DirectiveLabel,
  HighlightedText,
  type BlockDirectiveKind,
} from "@/routes/_protected.knowledge/-components/paragraph-rendering";
import { useTemplateAssistantStore } from "@/routes/_protected.knowledge/-store/template-assistant-store";

// ── Types ────────────────────────────────────────────────

type ParagraphSource = "header" | "body" | "footer";

type ExtractedParagraph = {
  index: number;
  text: string;
  style?: string;
  source?: ParagraphSource;
  bold?: boolean;
  fontSize?: number;
  alignment?: "left" | "center" | "right" | "both";
  isDirective?: boolean;
  directiveKind?: BlockDirectiveKind;
  directiveExpression?: string;
};

type StructureError = {
  message: string;
  paragraphIndex: number;
  directive: string;
};

type PreviewData = {
  paragraphs: ExtractedParagraph[];
  charCount: number;
  structureErrors: StructureError[];
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

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];

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
  if (!halfPoints) {
    return;
  }
  // DOCX stores font size in half-points (24 = 12pt).
  // Base UI text-sm is ~14px ≈ 10.5pt ≈ 21 half-points.
  // Only deviate when the document uses non-default sizes.
  if (halfPoints <= 18) {
    return "0.75rem"; // ~12px, small
  }
  if (halfPoints <= 22) {
    return; // ~11pt, close to default
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
const ConnectorLines = ({ activeSpans }: { activeSpans: BlockSpan[] }) => (
  <>
    {activeSpans.map((span) => (
      <div
        className={`absolute top-0 bottom-0 w-px ${
          span.isConditional
            ? "bg-blue-300 dark:bg-blue-700"
            : "bg-emerald-300 dark:bg-emerald-700"
        }`}
        key={`${span.startIdx}-${span.depth}`}
        style={{ left: span.depth * LINE_OFFSET + 7 }}
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
  error?: StructureError;
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
          className={`rounded-sm border-l-[3px] py-1.5 pr-2 pl-3 ${
            isConditional
              ? "border-blue-400 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/20"
              : "border-emerald-400 bg-emerald-50/50 dark:border-emerald-600 dark:bg-emerald-950/20"
          }`}
          style={{ marginLeft: depth * LINE_OFFSET }}
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
        style={{ paddingLeft: depth * LINE_OFFSET }}
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
  <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
    <AlertTriangleIcon className="size-3 shrink-0" />
    {error.message}
  </p>
);

/** Subtle divider between header/body/footer sections. */
const SectionDivider = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 pt-2 pb-1">
    <div className="h-px flex-1 bg-border" />
    <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
      {label}
    </span>
    <div className="h-px flex-1 bg-border" />
  </div>
);

// ── Main component ───────────────────────────────────────

export const TemplatePreview = ({ templateId }: { templateId: string }) => {
  const t = useTranslations("templates");
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: PreviewData }
    | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const response = await api.templates({ templateId }).preview.get();

      if (cancelled) {
        return;
      }

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("previewFailed"),
          description: userErrorMessage(response.error, t("previewFailed")),
        });
        setState({ kind: "error" });
        return;
      }

      const data = response.data;
      if (data instanceof Response || !("paragraphs" in data)) {
        setState({ kind: "error" });
        return;
      }

      setState({ kind: "ready", data });
    };

    // biome-ignore lint/nursery/noFloatingPromises: effect
    load();

    return () => {
      cancelled = true;
    };
  }, [templateId, t]);

  const setSelectedText = useTemplateAssistantStore((s) => s.setSelectedText);

  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text && text.length > 0) {
      setSelectedText(text);
    }
  }, [setSelectedText]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t("discovering")}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t("previewFailed")}</p>
      </div>
    );
  }

  const { paragraphs, structureErrors } = state.data;

  if (paragraphs.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t("previewEmpty")}</p>
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
    // biome-ignore lint/a11y/noStaticElementInteractions: text selection handler
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: text selection handler
    <div
      className="space-y-0.5 py-2"
      onKeyUp={handleTextSelection}
      onMouseUp={handleTextSelection}
    >
      {paragraphs.map((p, i) => {
        // Show section divider at the first paragraph of
        // each new source section (only when mixed sources)
        const prevSource = i > 0 ? paragraphs[i - 1].source : undefined;
        const source = p.source;
        const showDivider =
          hasMultipleSections && source !== undefined && source !== prevSource;

        const sectionLabel =
          source === "header"
            ? t("previewSectionHeader")
            : source === "footer"
              ? t("previewSectionFooter")
              : t("previewSectionBody");

        return (
          <div key={p.index}>
            {showDivider && <SectionDivider label={sectionLabel} />}
            <PreviewParagraph
              activeSpans={activeLines.get(i) ?? []}
              depth={depths[i]}
              error={errorsByIndex.get(p.index)}
              paragraph={p}
            />
          </div>
        );
      })}
    </div>
  );
};
