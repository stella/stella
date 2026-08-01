import type { FolioVersionDiff } from "@stll/folio-core/server";

const COUNTED_TOKEN_RE = /[\p{L}\p{N}_]+/gu;

const countTextTokens = (text: string): number =>
  text.match(COUNTED_TOKEN_RE)?.length ?? 0;

type VersionDiffWordCounts = {
  wordsAdded: number;
  wordsRemoved: number;
};

export const countVersionDiffWords = (
  diff: Pick<FolioVersionDiff, "changes">,
): VersionDiffWordCounts => {
  let wordsAdded = 0;
  let wordsRemoved = 0;

  for (const change of diff.changes) {
    if (change.type === "added") {
      wordsAdded += countTextTokens(change.text);
      continue;
    }
    if (change.type === "deleted") {
      wordsRemoved += countTextTokens(change.text);
      continue;
    }
    if (change.type !== "modified") {
      continue;
    }
    for (const segment of change.segments) {
      if (segment.type === "ins") {
        wordsAdded += countTextTokens(segment.text);
      } else if (segment.type === "del") {
        wordsRemoved += countTextTokens(segment.text);
      }
    }
  }

  return { wordsAdded, wordsRemoved };
};
