/**
 * Line-level diff between two plain-text document versions,
 * rendered as compact segments for version-history UIs and as
 * unified-diff text for AI change summaries. Long unchanged runs
 * are collapsed to a couple of context lines around each change so
 * responses stay bounded even for large documents.
 */

import { diffArrays } from "diff";

export type VersionDiffSegment = {
  kind: "added" | "removed" | "unchanged" | "gap";
  text: string;
};

/** Unchanged lines kept on each side of a change. */
const CONTEXT_LINES = 2;
/** Per-segment text cap; pathological single segments get truncated. */
const MAX_SEGMENT_CHARS = 10_000;
/** Total response cap across all segments. */
const MAX_TOTAL_CHARS = 60_000;

const TRUNCATION_SUFFIX = "\n…";

const toLines = (text: string): string[] =>
  text.length === 0 ? [] : text.split("\n");

const clampSegmentText = (text: string): string =>
  text.length > MAX_SEGMENT_CHARS
    ? text.slice(0, MAX_SEGMENT_CHARS) + TRUNCATION_SUFFIX
    : text;

/**
 * Diff two texts line-by-line. Returns an empty array when nothing
 * changed; otherwise returns added/removed segments interleaved with
 * trimmed unchanged context ("gap" marks elided unchanged lines).
 */
export const buildLineDiffSegments = (
  prevText: string,
  nextText: string,
): VersionDiffSegment[] => {
  const changes = diffArrays(toLines(prevText), toLines(nextText));
  const hasChanges = changes.some((c) => c.added || c.removed);
  if (!hasChanges) {
    return [];
  }

  const segments: VersionDiffSegment[] = [];
  let totalChars = 0;

  const push = (segment: VersionDiffSegment): boolean => {
    if (totalChars >= MAX_TOTAL_CHARS) {
      const last = segments.at(-1);
      if (last?.kind !== "gap") {
        segments.push({ kind: "gap", text: "" });
      }
      return false;
    }
    const text = clampSegmentText(segment.text);
    totalChars += text.length;
    segments.push({ kind: segment.kind, text });
    return true;
  };

  for (const [index, change] of changes.entries()) {
    if (change.added) {
      push({ kind: "added", text: change.value.join("\n") });
      continue;
    }
    if (change.removed) {
      push({ kind: "removed", text: change.value.join("\n") });
      continue;
    }

    // Unchanged run: keep only the lines adjacent to a change.
    const isFirst = index === 0;
    const isLast = index === changes.length - 1;
    const lines = change.value;
    const head = isFirst ? [] : lines.slice(0, CONTEXT_LINES);
    const tail = isLast ? [] : lines.slice(-CONTEXT_LINES);

    if (head.length + tail.length >= lines.length) {
      push({ kind: "unchanged", text: lines.join("\n") });
      continue;
    }
    if (head.length > 0) {
      push({ kind: "unchanged", text: head.join("\n") });
    }
    push({ kind: "gap", text: "" });
    if (tail.length > 0) {
      push({ kind: "unchanged", text: tail.join("\n") });
    }
  }

  return segments;
};

const SEGMENT_PREFIX: Record<VersionDiffSegment["kind"], string> = {
  added: "+ ",
  removed: "- ",
  unchanged: "  ",
  gap: "",
};

/**
 * Render segments as unified-diff-style text for an AI prompt
 * ("+ " added, "- " removed, "  " context, "@@" elided run).
 */
export const diffSegmentsToText = (
  segments: readonly VersionDiffSegment[],
): string =>
  segments
    .map((segment) => {
      if (segment.kind === "gap") {
        return "@@";
      }
      const prefix = SEGMENT_PREFIX[segment.kind];
      return segment.text
        .split("\n")
        .map((line) => prefix + line)
        .join("\n");
    })
    .join("\n");
