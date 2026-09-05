import type { CSSProperties, ReactNode } from "react";

import { panic } from "better-result";

import { cn } from "../lib/utils";

// Track-changes styling, matched to folio's suggestion preview
// (.folio-ai-suggestion--focused-original/-replacement): deletions read as
// dimmed muted strikethrough with a faint destructive tint, insertions as a
// low-saturation success wash with an inset ring. color-mix over semantic
// tokens keeps both theme-aware without importing folio's stylesheet.
//
// One definition for the whole product: every surface that shows a text
// difference (document versions, statute provisions, AI redlines) has to read
// as the same visual language, and a second copy would drift from this one
// silently.

export const TRACKED_DELETION_STYLE: CSSProperties = {
  color: "color-mix(in oklch, var(--destructive) 35%, var(--muted-foreground))",
  textDecorationLine: "line-through",
  textDecorationThickness: "1px",
  textDecorationColor:
    "color-mix(in oklch, var(--destructive) 30%, var(--muted-foreground))",
};

export const TRACKED_INSERTION_STYLE: CSSProperties = {
  borderRadius: "3px",
  padding: "0 2px",
  backgroundColor: "color-mix(in oklch, var(--success) 14%, transparent)",
  boxShadow:
    "inset 0 0 0 1px color-mix(in oklch, var(--success) 28%, transparent)",
  textDecorationLine: "none",
  boxDecorationBreak: "clone",
  WebkitBoxDecorationBreak: "clone",
};

export type ReviewDiffSegmentType = "equal" | "insert" | "delete";

export type ReviewDiffSegment = {
  type: ReviewDiffSegmentType;
  text: string;
};

type ReviewDiffProps = {
  className?: string;
  children: ReactNode;
};

/** Inserted text, wherever it is shown. */
export const ReviewDiffInsertion = ({
  className,
  children,
}: ReviewDiffProps) => (
  <ins className={className} style={TRACKED_INSERTION_STYLE}>
    {children}
  </ins>
);

/** Deleted text, wherever it is shown. */
export const ReviewDiffDeletion = ({
  className,
  children,
}: ReviewDiffProps) => (
  <del className={className} style={TRACKED_DELETION_STYLE}>
    {children}
  </del>
);

type ReviewDiffTextProps = {
  segments: readonly ReviewDiffSegment[];
  className?: string;
};

/** A word-level diff rendered inline, in the product's one track-changes
 *  language. */
export const ReviewDiffText = ({
  segments,
  className,
}: ReviewDiffTextProps) => {
  const keys = reviewDiffSegmentKeys(segments);
  return (
    <span className={cn(className)} data-slot="review-diff-text">
      {segments.map((segment, index) => (
        <ReviewDiffSegmentSpan key={keys[index]} segment={segment} />
      ))}
    </span>
  );
};

/**
 * A stable render key per segment. Type and text alone repeat inside a single
 * diff (the same word deleted twice), so each repetition carries its
 * occurrence count; the result is stable across renders of the same diff and
 * never falls back to the array index.
 */
export const reviewDiffSegmentKeys = (
  segments: readonly ReviewDiffSegment[],
): string[] => {
  const seen = new Map<string, number>();
  return segments.map((segment) => {
    const base = `${segment.type}-${segment.text}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}-${occurrence}`;
  });
};

const ReviewDiffSegmentSpan = ({ segment }: { segment: ReviewDiffSegment }) => {
  switch (segment.type) {
    case "insert":
      return <ReviewDiffInsertion>{segment.text}</ReviewDiffInsertion>;
    case "delete":
      return <ReviewDiffDeletion>{segment.text}</ReviewDiffDeletion>;
    case "equal":
      return <span>{segment.text}</span>;
    default:
      segment.type satisfies never;
      return panic(`Unhandled type: ${String(segment.type)}`);
  }
};
