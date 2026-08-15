import { createHash } from "node:crypto";

type SelectMatterNamesOptions = {
  matterCount: number;
  matterNames: readonly string[];
  selectionSeed?: string;
};

/**
 * Select a stable subset from the corpus manifest without mutating it.
 *
 * The CLI keeps its historical alphabetical selection when no seed is given.
 * Dev Quick Start supplies a random seed, which makes each new workspace vary
 * while keeping the exact selection reproducible from that seed.
 */
export const selectMatterNames = ({
  matterCount,
  matterNames,
  selectionSeed,
}: SelectMatterNamesOptions): string[] => {
  const uniqueNames = [...new Set(matterNames)].sort((a, b) =>
    a.localeCompare(b),
  );
  if (selectionSeed === undefined) {
    return uniqueNames.slice(0, matterCount);
  }

  return uniqueNames
    .map((name) => ({
      name,
      rank: createHash("sha256")
        .update(selectionSeed)
        .update("\0")
        .update(name)
        .digest("hex"),
    }))
    .sort(
      (a, b) => a.rank.localeCompare(b.rank) || a.name.localeCompare(b.name),
    )
    .slice(0, matterCount)
    .map(({ name }) => name);
};
