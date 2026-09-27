import { Result, TaggedError } from "better-result";

import type { ParsedList, SanctionsSource } from "./entry";

/** What a caller keeps about the edition it currently screens against. */
export type ListStats = {
  source: SanctionsSource;
  publishedAt: string;
  entryCount: number;
};

export type ReplacementPolicy = {
  /** Fewest entries a first edition may have. */
  minimumEntries: number;
  /** Largest share of the previous edition's entries a new one may drop. */
  maximumShrink: number;
};

// Delistings arrive a few at a time, so a well-formed file that loses more
// than this is far likelier a broken export than a real edition. Minimums sit
// well under today's sizes (EU about 6,200 entries, UN about 1,000). The
// Czech list is small and shrinks whenever the EU takes over a designation,
// so it only has to be non-empty and may halve between editions.
const REPLACEMENT_POLICIES = {
  eu: { minimumEntries: 3000, maximumShrink: 0.1 },
  un: { minimumEntries: 500, maximumShrink: 0.1 },
  cz: { minimumEntries: 1, maximumShrink: 0.5 },
} as const satisfies Record<SanctionsSource, ReplacementPolicy>;

export class ListReplacementError extends TaggedError("ListReplacementError")<{
  code: "source-mismatch" | "below-minimum" | "contracted";
  message: string;
  source: SanctionsSource;
}> {}

export const listStats = ({ version, entries }: ParsedList): ListStats => ({
  source: version.source,
  publishedAt: version.publishedAt,
  entryCount: entries.length,
});

type CheckListReplacementInput = {
  /** The edition in use; null when the source has never been loaded. */
  previous: ListStats | null;
  next: ParsedList;
  policy?: ReplacementPolicy;
};

/**
 * Decides whether a freshly parsed edition may replace the one in use. A
 * parse proves the file is well formed, not that it is complete; this refuses
 * a first edition below the source's minimum and an edition that shrank more
 * than the policy allows.
 */
export const checkListReplacement = ({
  previous,
  next,
  policy = REPLACEMENT_POLICIES[next.version.source],
}: CheckListReplacementInput): Result<ListStats, ListReplacementError> => {
  const stats = listStats(next);
  const fail = (code: ListReplacementError["code"], message: string) =>
    Result.err(
      new ListReplacementError({ code, message, source: stats.source }),
    );
  if (previous === null) {
    return stats.entryCount < policy.minimumEntries
      ? fail(
          "below-minimum",
          `${stats.entryCount} entries; a first ${stats.source} edition needs at least ${policy.minimumEntries}`,
        )
      : Result.ok(stats);
  }
  if (previous.source !== stats.source) {
    return fail(
      "source-mismatch",
      `a ${stats.source} edition cannot replace a ${previous.source} one`,
    );
  }
  const floor = Math.ceil(previous.entryCount * (1 - policy.maximumShrink));
  return stats.entryCount < floor
    ? fail(
        "contracted",
        `${stats.entryCount} entries against ${previous.entryCount} in the edition of ${previous.publishedAt}`,
      )
    : Result.ok(stats);
};
