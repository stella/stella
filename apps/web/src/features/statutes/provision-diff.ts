import { panic } from "better-result";

export type ProvisionDiffSegmentKind = "equal" | "inserted" | "removed";

export type ProvisionDiffSegment = {
  kind: ProvisionDiffSegmentKind;
  text: string;
};

/**
 * Alignment is quadratic in the token count, so a provision longer than this
 * is reported as a wholesale replacement rather than a word-level edit. A
 * consolidated section is a few hundred tokens; anything past the limit is
 * a whole chapter, where a word diff would be unreadable anyway.
 */
const ALIGNMENT_TOKEN_LIMIT = 1200;

/** Whitespace is kept as its own token so the output rebuilds the input. */
const TOKEN_BOUNDARY = /(\s+)/u;

const tokenize = (text: string): string[] =>
  text.split(TOKEN_BOUNDARY).filter((token) => token.length > 0);

const tokenAt = (tokens: readonly string[], index: number): string =>
  tokens[index] ??
  panic("Provision diff read a token outside the aligned range");

/**
 * Longest-common-subsequence alignment over tokens, walked forwards so the
 * segments come out in reading order.
 */
const alignTokens = (
  before: readonly string[],
  after: readonly string[],
): ProvisionDiffSegment[] => {
  const columns = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * columns);
  const commonAt = (row: number, column: number): number =>
    lengths[row * columns + column] ??
    panic("Provision diff read outside its alignment matrix");

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] =
        tokenAt(before, row) === tokenAt(after, column)
          ? commonAt(row + 1, column + 1) + 1
          : Math.max(commonAt(row + 1, column), commonAt(row, column + 1));
    }
  }

  const segments: ProvisionDiffSegment[] = [];
  let row = 0;
  let column = 0;

  while (row < before.length && column < after.length) {
    if (tokenAt(before, row) === tokenAt(after, column)) {
      segments.push({ kind: "equal", text: tokenAt(before, row) });
      row += 1;
      column += 1;
      continue;
    }

    if (commonAt(row + 1, column) >= commonAt(row, column + 1)) {
      segments.push({ kind: "removed", text: tokenAt(before, row) });
      row += 1;
      continue;
    }

    segments.push({ kind: "inserted", text: tokenAt(after, column) });
    column += 1;
  }

  for (; row < before.length; row += 1) {
    segments.push({ kind: "removed", text: tokenAt(before, row) });
  }

  for (; column < after.length; column += 1) {
    segments.push({ kind: "inserted", text: tokenAt(after, column) });
  }

  return segments;
};

/** Adjacent segments of one kind read as one run of changed text. */
const mergeRuns = (
  segments: readonly ProvisionDiffSegment[],
): ProvisionDiffSegment[] => {
  const merged: ProvisionDiffSegment[] = [];

  for (const segment of segments) {
    if (segment.text.length === 0) {
      continue;
    }

    const previous = merged.at(-1);

    if (previous?.kind === segment.kind) {
      merged[merged.length - 1] = {
        kind: previous.kind,
        text: previous.text + segment.text,
      };
      continue;
    }

    merged.push(segment);
  }

  return merged;
};

const replacement = (
  before: readonly string[],
  after: readonly string[],
): ProvisionDiffSegment[] => [
  { kind: "removed", text: before.join("") },
  { kind: "inserted", text: after.join("") },
];

/**
 * Word-level difference between two wordings of the same provision, as a flat
 * run of segments a reader can render in order. Common leading and trailing
 * tokens are matched before the alignment runs, which is what keeps a
 * one-word amendment to a long section cheap.
 */
export const diffProvisionText = (
  before: string,
  after: string,
): ProvisionDiffSegment[] => {
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);

  let prefix = 0;

  while (
    prefix < beforeTokens.length &&
    prefix < afterTokens.length &&
    tokenAt(beforeTokens, prefix) === tokenAt(afterTokens, prefix)
  ) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < beforeTokens.length - prefix &&
    suffix < afterTokens.length - prefix &&
    tokenAt(beforeTokens, beforeTokens.length - 1 - suffix) ===
      tokenAt(afterTokens, afterTokens.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const beforeMiddle = beforeTokens.slice(prefix, beforeTokens.length - suffix);
  const afterMiddle = afterTokens.slice(prefix, afterTokens.length - suffix);
  const oversized =
    beforeMiddle.length > ALIGNMENT_TOKEN_LIMIT ||
    afterMiddle.length > ALIGNMENT_TOKEN_LIMIT;

  return mergeRuns([
    { kind: "equal", text: beforeTokens.slice(0, prefix).join("") },
    ...(oversized
      ? replacement(beforeMiddle, afterMiddle)
      : alignTokens(beforeMiddle, afterMiddle)),
    {
      kind: "equal",
      text: beforeTokens.slice(beforeTokens.length - suffix).join(""),
    },
  ]);
};

/** One consolidation's wording of a provision, as the history read returns it. */
type ProvisionVersion = {
  documentId: string;
  text: string;
};

/**
 * The versions in which a provision was actually rewritten, from a
 * newest-first run of its wording per consolidation.
 *
 * A consolidation that reissues a provision unchanged is not part of its
 * history, so it is folded away. The oldest wording in the run is always
 * kept: it is the earliest wording on record, not a repetition of anything.
 */
export const selectChangedVersions = <T extends ProvisionVersion>(
  versions: readonly T[],
): T[] =>
  versions.filter((version, index) => {
    const older = versions.at(index + 1);

    return older === undefined || older.text !== version.text;
  });

type ResolveSelectedVersionOptions<T extends ProvisionVersion> = {
  /** Every consolidation read so far, newest first, nothing folded away. */
  consolidations: readonly T[];
  /** The result of `selectChangedVersions` over them. */
  changed: readonly T[];
  selectedId: string | null;
};

/**
 * Which entry of the history a selection points at.
 *
 * The folded list is not stable across pages: loading older consolidations
 * can reveal that the selected one merely reissued the wording its
 * predecessor introduced, at which point folding drops it. Reading the
 * selection back by position would then silently jump to the newest entry, so
 * a dropped selection is resolved to the entry that represents its wording:
 * folding keeps the oldest consolidation of an equal-wording run, which is
 * the first kept entry at or below the selected one.
 */
export const resolveSelectedVersion = <T extends ProvisionVersion>({
  changed,
  consolidations,
  selectedId,
}: ResolveSelectedVersionOptions<T>): T | undefined => {
  const newest = changed.at(0);

  if (selectedId === null) {
    return newest;
  }

  const kept = new Set(changed.map((version) => version.documentId));

  if (kept.has(selectedId)) {
    return changed.find((version) => version.documentId === selectedId);
  }

  const selectedIndex = consolidations.findIndex(
    (version) => version.documentId === selectedId,
  );

  if (selectedIndex === -1) {
    return newest;
  }

  return (
    consolidations
      .slice(selectedIndex)
      .find((version) => kept.has(version.documentId)) ?? newest
  );
};
