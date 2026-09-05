/**
 * Redline preview for a single suggestion. Renders the proposed change inline
 * as a mini-diff, through the shared track-changes rendering: deleted text as
 * `<del>`, inserted text as `<ins>`, and the surrounding block context (when
 * we have it) sits in a muted, smaller weight so the reviewer can see WHERE
 * in the block the edit lands without leaving the panel. The document is
 * never touched — this is purely a panel-side rendering.
 */

import type { CSSProperties } from "react";

import { panic } from "better-result";
import { ArrowRightIcon } from "lucide-react";

import { diffWordSegments } from "@stll/folio-react";
import type {
  FolioAIBlockPreviewRun,
  WordDiffSegment,
} from "@stll/folio-react";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import type { ReviewDiffSegmentType } from "@stll/ui/review-diff-text";
import {
  ReviewDiffDeletion,
  ReviewDiffInsertion,
  ReviewDiffText,
} from "@stll/ui/review-diff-text";
import { cn } from "@stll/ui/utils";

import type { ReviewSuggestionPreview } from "@/components/ai-suggestions/review-store";

/** folio's word diff names its sides `del`/`ins`; the shared diff renderer
 *  spells them out. Total, so a new folio segment kind cannot render blank. */
const REVIEW_DIFF_SEGMENT_TYPE = {
  equal: "equal",
  del: "delete",
  ins: "insert",
} as const satisfies Record<WordDiffSegment["type"], ReviewDiffSegmentType>;

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
    "text-foreground [font-family:Calibri,Arial,sans-serif] wrap-break-word",
    compact
      ? "line-clamp-1 text-[13.5px] leading-5"
      : "text-[14.5px] leading-6",
    rejected && "opacity-60",
  );
  const muted = "text-foreground-strong-muted";
  const contextCls = "text-foreground";

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
          <ReviewDiffDeletion>{before}</ReviewDiffDeletion>
          {arrow}
          <ReviewDiffInsertion>{after}</ReviewDiffInsertion>
        </>
      );
    }
    return (
      <ReviewDiffText
        segments={segments.map((seg) => ({
          text: seg.text,
          type: REVIEW_DIFF_SEGMENT_TYPE[seg.type],
        }))}
      />
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
            <ReviewDiffDeletion>
              {renderFormattedRuns(
                slicePreviewRuns(
                  preview.sourceRuns,
                  preview.matchStart,
                  preview.matchEnd,
                ),
              )}
            </ReviewDiffDeletion>
            {arrow}
            <ReviewDiffInsertion>{preview.after}</ReviewDiffInsertion>
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
            <ReviewDiffDeletion>
              {renderFormattedRuns(preview.sourceRuns)}
            </ReviewDiffDeletion>
            {arrow}
            <ReviewDiffInsertion>{preview.after}</ReviewDiffInsertion>
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
            <ReviewDiffDeletion>
              {renderFormattedRuns(preview.sourceRuns)}
            </ReviewDiffDeletion>
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={baseCls} role="group">
          <ReviewDiffDeletion>{preview.before}</ReviewDiffDeletion>
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
          <ReviewDiffInsertion>{preview.after}</ReviewDiffInsertion>
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
          <ReviewDiffInsertion>{partyList}</ReviewDiffInsertion>
        </p>
      );
    }
    default:
      preview satisfies never;
      return panic(`Unhandled preview: ${String(preview)}`);
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
