import { compareCodeUnit } from "@stll/collation";
import { createSha256 } from "@stll/sha256/bun";

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
  const uniqueNames = [...new Set(matterNames)].toSorted(compareCodeUnit);
  if (selectionSeed === undefined) {
    return uniqueNames.slice(0, matterCount);
  }

  return uniqueNames
    .map((name) => ({
      name,
      rank: createSha256()
        .update(selectionSeed)
        .update("\0")
        .update(name)
        .digest("hex"),
    }))
    .toSorted(
      (a, b) =>
        compareCodeUnit(a.rank, b.rank) || compareCodeUnit(a.name, b.name),
    )
    .slice(0, matterCount)
    .map(({ name }) => name);
};
