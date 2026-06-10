/**
 * Two-pass diff between two plain-text document versions, rendered as
 * compact segments for version-history UIs and as unified-diff text
 * for AI change summaries. The first pass diffs line-by-line; the
 * second pass zips adjacent removed/added lines by index and word-diffs
 * each pair into a single "changed" paragraph of inline same/del/ins
 * runs, the granularity lawyers know from track changes. Long unchanged
 * runs are collapsed to a couple of context lines around each change so
 * responses stay bounded even for large documents.
 */

import { diffArrays, diffWordsWithSpace } from "diff";

export type VersionDiffRun = {
  kind: "same" | "del" | "ins";
  text: string;
};

export type VersionDiffSegment =
  | { kind: "added" | "removed" | "unchanged" | "gap"; text: string }
  | { kind: "changed"; runs: VersionDiffRun[] };

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

const segmentLength = (segment: VersionDiffSegment): number => {
  if (segment.kind === "changed") {
    let length = 0;
    for (const run of segment.runs) {
      length += run.text.length;
    }
    return length;
  }
  return segment.text.length;
};

const toRunKind = (part: {
  added: boolean;
  removed: boolean;
}): VersionDiffRun["kind"] => {
  if (part.added) {
    return "ins";
  }
  if (part.removed) {
    return "del";
  }
  return "same";
};

/**
 * Diff two texts line-by-line, then word-by-word within changed line
 * pairs. Returns an empty array when nothing changed; otherwise
 * returns segments interleaved with trimmed unchanged context:
 * "changed" merges an edited line pair into inline same/del/ins runs,
 * "added"/"removed" carry whole inserted/deleted lines, and "gap"
 * marks elided unchanged lines.
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

  const push = (segment: VersionDiffSegment): void => {
    if (totalChars >= MAX_TOTAL_CHARS) {
      const last = segments.at(-1);
      if (last?.kind !== "gap") {
        segments.push({ kind: "gap", text: "" });
      }
      return;
    }
    // "changed" segments are bounded by construction (a pair only gets
    // word-diffed when its combined length fits the per-segment cap).
    const bounded: VersionDiffSegment =
      segment.kind === "changed"
        ? segment
        : { kind: segment.kind, text: clampSegmentText(segment.text) };
    totalChars += segmentLength(bounded);
    segments.push(bounded);
  };

  /** Zip a removed run with the added run that follows it: line pairs
   *  matched by index merge into word-level "changed" segments; the
   *  longer side's leftover lines stay plain removed/added. */
  const pushChangedPairs = (oldLines: string[], newLines: string[]): void => {
    const pairCount = Math.min(oldLines.length, newLines.length);
    for (const [i, oldLine] of oldLines.slice(0, pairCount).entries()) {
      const newLine = newLines.at(i) ?? "";
      if (oldLine.length + newLine.length > MAX_SEGMENT_CHARS) {
        push({ kind: "removed", text: oldLine });
        push({ kind: "added", text: newLine });
        continue;
      }
      push({
        kind: "changed",
        runs: diffWordsWithSpace(oldLine, newLine).map((part) => ({
          kind: toRunKind(part),
          text: part.value,
        })),
      });
    }
    if (oldLines.length > pairCount) {
      push({ kind: "removed", text: oldLines.slice(pairCount).join("\n") });
    }
    if (newLines.length > pairCount) {
      push({ kind: "added", text: newLines.slice(pairCount).join("\n") });
    }
  };

  let index = 0;
  while (index < changes.length) {
    const change = changes.at(index);
    if (!change) {
      break;
    }
    const next = changes.at(index + 1);

    if (change.removed && next?.added) {
      pushChangedPairs(change.value, next.value);
      index += 2;
      continue;
    }
    if (change.added) {
      push({ kind: "added", text: change.value.join("\n") });
      index += 1;
      continue;
    }
    if (change.removed) {
      push({ kind: "removed", text: change.value.join("\n") });
      index += 1;
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
      index += 1;
      continue;
    }
    if (head.length > 0) {
      push({ kind: "unchanged", text: head.join("\n") });
    }
    push({ kind: "gap", text: "" });
    if (tail.length > 0) {
      push({ kind: "unchanged", text: tail.join("\n") });
    }
    index += 1;
  }

  return segments;
};

const SEGMENT_PREFIX: Record<"added" | "removed" | "unchanged", string> = {
  added: "+ ",
  removed: "- ",
  unchanged: "  ",
};

/** Reassemble one side of a merged "changed" pair from its runs. */
const joinRunsExcluding = (
  runs: readonly VersionDiffRun[],
  excluded: "ins" | "del",
): string => {
  let text = "";
  for (const run of runs) {
    if (run.kind !== excluded) {
      text += run.text;
    }
  }
  return text;
};

/**
 * Render segments as unified-diff-style text for an AI prompt
 * ("+ " added, "- " removed, "  " context, "@@" elided run).
 * Merged "changed" pairs are re-expanded into a -/+ line pair so the
 * prompt stays plain unified-diff text.
 */
export const diffSegmentsToText = (
  segments: readonly VersionDiffSegment[],
): string =>
  segments
    .map((segment) => {
      if (segment.kind === "gap") {
        return "@@";
      }
      if (segment.kind === "changed") {
        const oldText = joinRunsExcluding(segment.runs, "ins");
        const newText = joinRunsExcluding(segment.runs, "del");
        return `- ${oldText}\n+ ${newText}`;
      }
      const prefix = SEGMENT_PREFIX[segment.kind];
      return segment.text
        .split("\n")
        .map((line) => prefix + line)
        .join("\n");
    })
    .join("\n");
