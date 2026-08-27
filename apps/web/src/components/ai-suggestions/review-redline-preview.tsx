/**
 * Redline preview for a single suggestion. Renders the proposed change inline
 * as a mini-diff: the deleted text gets a destructive-toned strikethrough, the
 * inserted text an accent-toned underline, and the surrounding block context
 * (when we have it) sits in a muted, smaller weight so the reviewer can see
 * WHERE in the block the edit lands without leaving the panel. The document is
 * never touched — this is purely a panel-side rendering.
 */

import type { CSSProperties } from "react";

import { ArrowRightIcon } from "lucide-react";

import { diffWordSegments } from "@stll/folio-react";
import type { FolioAIBlockPreviewRun } from "@stll/folio-react";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { cn } from "@stll/ui/utils";

import type { ReviewSuggestionPreview } from "@/components/ai-suggestions/review-store";

type RedlinePreviewProps = {
  preview: ReviewSuggestionPreview;
  /** Plain-text summary used as the accessible label. */
  srSummary: string;
  rejected: boolean;
  compact?: boolean | undefined;
};

export const RedlinePreview = ({
  preview,
  srSummary,
  rejected,
  compact = false,
}: RedlinePreviewProps) => {
  const baseCls = cn(
    "text-foreground [font-family:Calibri,Arial,sans-serif] break-words",
    compact
      ? "line-clamp-1 text-[13.5px] leading-5"
      : "text-[14.5px] leading-6",
    rejected && "opacity-60",
  );
  const muted = "text-foreground-strong-muted";
  const contextCls = "text-foreground";
  const insCls = "bg-success/15 text-success px-1 py-0.5 rounded-sm";
  const delCls =
    "bg-destructive/10 text-destructive line-through decoration-destructive/70 px-1 py-0.5 rounded-sm";

  const arrow = (
    <DirectionalIcon
      className="text-foreground-ghost mx-1 inline size-3.5 align-middle"
      icon={ArrowRightIcon}
    />
  );

  const renderFormattedRuns = (
    runs: readonly FolioAIBlockPreviewRun[],
    className?: string,
  ) =>
    runs.map((run, index) => (
      <span
        className={className}
        // eslint-disable-next-line react/no-array-index-key -- runs is a read-only preview recomputed fresh from the AI suggestion on every render (whole-list replace); spans are non-interactive with no per-item state.
        key={`${index}-${run.text}`}
        style={previewRunStyle(run, compact)}
      >
        {run.text}
      </span>
    ));

  const renderDiff = (before: string, after: string) => {
    const segments = diffWordSegments(before, after);
    // If the diff degenerates to a single delete + single insert
    // (no shared tokens at all), fall back to the arrow shape —
    // the inline diff would just show the same two halves
    // separated by nothing.
    const hasShared = segments.some((seg) => seg.type === "equal");
    if (!hasShared) {
      return (
        <>
          <span className={delCls}>{before}</span>
          {arrow}
          <span className={insCls}>{after}</span>
        </>
      );
    }
    return withStableKeys(segments, (seg) => `${seg.type}-${seg.text}`).map(
      ({ item: seg, key }) => {
        if (seg.type === "equal") {
          return <span key={key}>{seg.text}</span>;
        }
        return (
          <span className={cn(seg.type === "del" ? delCls : insCls)} key={key}>
            {seg.text}
          </span>
        );
      },
    );
  };

  switch (preview.type) {
    case "replaceInBlock":
      if (isFormattedReplaceInBlockPreview(preview)) {
        return (
          <p aria-label={srSummary} className={baseCls} role="group">
            {renderFormattedRuns(
              slicePreviewRuns(
                preview.sourceRuns,
                preview.contextStart,
                preview.matchStart,
              ),
              contextCls,
            )}
            {renderFormattedRuns(
              slicePreviewRuns(
                preview.sourceRuns,
                preview.matchStart,
                preview.matchEnd,
              ),
              delCls,
            )}
            {arrow}
            <span className={insCls}>{preview.after}</span>
            {renderFormattedRuns(
              slicePreviewRuns(
                preview.sourceRuns,
                preview.matchEnd,
                preview.contextEnd,
              ),
              contextCls,
            )}
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={baseCls} role="group">
          {preview.contextBefore && (
            <span className={contextCls}>{preview.contextBefore}</span>
          )}
          {renderDiff(preview.before, preview.after)}
          {preview.contextAfter && (
            <span className={contextCls}>{preview.contextAfter}</span>
          )}
        </p>
      );
    case "replaceBlock":
      if (preview.sourceRuns !== undefined) {
        return (
          <p aria-label={srSummary} className={baseCls} role="group">
            {renderFormattedRuns(preview.sourceRuns, delCls)}
            {arrow}
            <span className={insCls}>{preview.after}</span>
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={baseCls} role="group">
          {renderDiff(preview.before, preview.after)}
        </p>
      );
    case "deleteBlock":
      if (preview.sourceRuns !== undefined) {
        return (
          <p aria-label={srSummary} className={baseCls} role="group">
            {renderFormattedRuns(preview.sourceRuns, delCls)}
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={baseCls} role="group">
          <span className={delCls}>{preview.before}</span>
        </p>
      );
    case "insertBeforeBlock":
    case "insertAfterBlock":
      return (
        <p aria-label={srSummary} className={baseCls} role="group">
          {preview.anchorRuns !== undefined &&
            preview.anchorEnd !== undefined && (
              <>
                {renderFormattedRuns(
                  slicePreviewRuns(preview.anchorRuns, 0, preview.anchorEnd),
                  contextCls,
                )}
                {arrow}
              </>
            )}
          <span className={insCls}>{preview.after}</span>
        </p>
      );
    case "commentOnBlock":
      if (preview.anchorRuns !== undefined && preview.anchorEnd !== undefined) {
        return (
          <p aria-label={srSummary} className={cn(baseCls, muted)} role="group">
            {renderFormattedRuns(
              slicePreviewRuns(preview.anchorRuns, 0, preview.anchorEnd),
            )}
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={cn(baseCls, muted)} role="group">
          {preview.anchor}
        </p>
      );
    case "insertSignatureTable": {
      // Compact preview: anchor snippet + an arrow + a column-list
      // of party names. The reviewer needs to recognise that this
      // is a structural insert, not free text — listing the party
      // names captures the gist without recreating the full table
      // layout inside the panel card.
      const partyList = preview.parties
        .flatMap((party) => (party.name.length > 0 ? [party.name] : []))
        .join("  |  ");
      return (
        <p aria-label={srSummary} className={baseCls} role="group">
          {preview.anchorRuns !== undefined &&
            preview.anchorEnd !== undefined && (
              <>
                {renderFormattedRuns(
                  slicePreviewRuns(preview.anchorRuns, 0, preview.anchorEnd),
                  contextCls,
                )}
                {arrow}
              </>
            )}
          <span className={insCls}>{partyList}</span>
        </p>
      );
    }
    default:
      preview satisfies never;
      return null;
  }
};

const isFormattedReplaceInBlockPreview = (
  preview: ReviewSuggestionPreview,
): preview is Extract<ReviewSuggestionPreview, { type: "replaceInBlock" }> &
  Required<
    Pick<
      Extract<ReviewSuggestionPreview, { type: "replaceInBlock" }>,
      "contextStart" | "matchStart" | "matchEnd" | "contextEnd" | "sourceRuns"
    >
  > =>
  preview.type === "replaceInBlock" &&
  preview.sourceRuns !== undefined &&
  preview.contextStart !== undefined &&
  preview.matchStart !== undefined &&
  preview.matchEnd !== undefined &&
  preview.contextEnd !== undefined;

const slicePreviewRuns = (
  runs: readonly FolioAIBlockPreviewRun[],
  start: number,
  end: number,
): FolioAIBlockPreviewRun[] => {
  const sliced: FolioAIBlockPreviewRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (runEnd <= start || runStart >= end) {
      continue;
    }

    const text = run.text.slice(
      Math.max(0, start - runStart),
      Math.min(run.text.length, end - runStart),
    );
    if (text.length === 0) {
      continue;
    }
    sliced.push({ ...run, text });
  }
  return sliced;
};

const previewRunStyle = (
  run: FolioAIBlockPreviewRun,
  compact: boolean,
): CSSProperties => {
  const style: CSSProperties = {};
  const fontFamily = cssFontFamily(run.fontFamily);
  if (fontFamily !== undefined) {
    style.fontFamily = fontFamily;
  }
  if (run.fontSizePt !== undefined) {
    const maxPt = compact ? 12.5 : 14.5;
    style.fontSize = `${Math.min(Math.max(run.fontSizePt, 8), maxPt)}pt`;
  }
  if (run.color !== undefined) {
    style.color = run.color;
  }
  if (run.bold) {
    style.fontWeight = 700;
  }
  if (run.italic) {
    style.fontStyle = "italic";
  }
  if (run.underline) {
    style.textDecorationLine = "underline";
  }
  if (run.strike) {
    if (style.textDecorationLine === "underline") {
      style.textDecorationLine = "underline line-through";
    } else {
      style.textDecorationLine = "line-through";
    }
  }
  return style;
};

const cssFontFamily = (fontFamily: string | undefined): string | undefined => {
  const first = fontFamily?.split(",").at(0)?.trim().replace(/["']/gu, "");
  if (!first || !/^[\p{L}\p{N} ._-]+$/u.test(first)) {
    return undefined;
  }

  if (first.includes(" ")) {
    return `"${first}", sans-serif`;
  }

  return `${first}, sans-serif`;
};

// Word-diff segments carry no id of their own (recomputed fresh from
// `before`/`after` on every render), so keys derive from type + text plus an
// occurrence counter so the same word appearing twice stays unique without
// leaning on the array index.
const withStableKeys = <T,>(items: readonly T[], base: (item: T) => string) => {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const b = base(item);
    const n = counts.get(b) ?? 0;
    counts.set(b, n + 1);
    return { item, key: `${b}-${n}` };
  });
};
