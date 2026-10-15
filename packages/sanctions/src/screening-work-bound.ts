import { panic } from "better-result";

import type { NameIndex } from "./name-match";
import type { NameReading } from "./normalise";
import type { ScreeningEntry } from "./screening-entries";

type VocabularyWorkStats = { strings: number; maxLength: number };

/** Edition-owned dimensions; independent of candidate order and query caches. */
export type ScreeningWorkStats = {
  folded: VocabularyWorkStats;
  raw: VocabularyWorkStats;
  aliases: number;
  maxAliasTokens: number;
  maxAliasUnits: number;
  aliasUnits: number;
  entries: number;
  maxIdentityWork: number;
  identityWork: number;
};

function* vocabularyStats(
  vocabulary: NameIndex["folded"],
): Generator<void, VocabularyWorkStats, void> {
  let maxLength = 0;
  for (let id = 0; id < vocabulary.strings.length; id += 1) {
    maxLength = Math.max(maxLength, vocabulary.strings.get(id).length);
    if (id % 4096 === 0) {
      yield;
    }
  }
  return { strings: vocabulary.strings.length, maxLength };
}

export function* screeningWorkStatsSteps(
  names: NameIndex,
  entries: { length: number; get: (id: number) => ScreeningEntry },
): Generator<void, ScreeningWorkStats, void> {
  const folded = yield* vocabularyStats(names.folded);
  const raw =
    names.raw === names.folded ? folded : yield* vocabularyStats(names.raw);
  let maxAliasTokens = 0;
  let maxAliasUnits = 0;
  let aliasUnits = 0;
  for (let id = 0; id < names.aliases.length; id += 1) {
    const alias = names.aliases.metadata(id);
    const units = alias.raw.length + alias.joins.length;
    maxAliasTokens = Math.max(maxAliasTokens, alias.raw.length);
    maxAliasUnits = Math.max(maxAliasUnits, units);
    aliasUnits += units;
    if (id % 4096 === 0) {
      yield;
    }
  }
  let maxIdentityWork = 0;
  let identityWork = 0;
  for (let id = 0; id < entries.length; id += 1) {
    const entry = entries.get(id);
    const cost =
      entry.birthDates.length +
      entry.nationalities.length +
      entry.identifiers.length +
      1;
    maxIdentityWork = Math.max(maxIdentityWork, cost);
    identityWork += cost;
    if (id % 4096 === 0) {
      yield;
    }
  }
  return {
    folded,
    raw,
    aliases: names.aliases.length,
    maxAliasTokens,
    maxAliasUnits,
    aliasUnits,
    entries: entries.length,
    maxIdentityWork,
    identityWork,
  };
}

const sortingWork = (count: number) => count * Math.ceil(Math.log2(count + 1));

const neighbourWork = (
  length: number,
  vocabulary: VocabularyWorkStats,
): number => {
  // UTF-16 length bounds both code-point count and each deletion key's length.
  // D <= 1 + L + choose(L, 2). Each key can post at most V ids; each
  // distinct candidate is verified at most once, costing at most L * M.
  const variants = 1 + length + (length * (length - 1)) / 2;
  return (
    (length + 1) * (variants + 1) +
    variants * vocabulary.strings +
    vocabulary.strings * Math.max(1, length * vocabulary.maxLength)
  );
};

type ScreeningWorkBoundOptions = {
  stats: ScreeningWorkStats;
  readings: readonly NameReading[];
  identifierCount: number;
};

/**
 * Static complete-scan bound, derived from the edition and validated input.
 * For T tokens and J adjacent pairs, U=T+J; each unit has at most two query
 * positions. Vocabulary size bounds both a delete posting and neighbour count.
 * Alias postings total at most S=sum(tokens+joins); pair work is at most
 * P=U*max(tokens+joins)+T*max(tokens). Every alias may be ranked and scored.
 * No observed timing, top-k selection, or cache hit is needed for this bound.
 */
export const screeningWorkBound = ({
  stats,
  readings,
  identifierCount,
}: ScreeningWorkBoundOptions): number => {
  let bound = 1;
  for (const reading of readings) {
    const tokens = reading.tokens.length;
    const units = tokens + reading.adjacent.length;
    const pairs = units * stats.maxAliasUnits + tokens * stats.maxAliasTokens;
    bound += units;
    for (const token of reading.tokens) {
      bound +=
        neighbourWork(token.folded.length, stats.folded) +
        neighbourWork(token.raw.length, stats.raw);
    }
    for (const positions of reading.adjacent) {
      let foldedLength = 0;
      let rawLength = 0;
      for (const position of positions) {
        const token =
          reading.tokens[position] ?? panic("Missing adjacent query token");
        foldedLength += token.folded.length;
        rawLength += token.raw.length;
      }
      bound +=
        neighbourWork(foldedLength, stats.folded) +
        neighbourWork(rawLength, stats.raw);
    }
    // Two vocabulary paths, one visit per position covered by each unit.
    bound += 2 * (tokens + 2 * reading.adjacent.length) * stats.aliasUnits;
    bound += tokens * stats.aliases;
    bound += stats.aliases * (1 + pairs + stats.maxIdentityWork);
    bound += sortingWork(stats.aliases);
    bound +=
      stats.aliases *
      (pairs * Math.max(1, Math.ceil(Math.log2(pairs + 1))) +
        stats.maxAliasTokens +
        1);
  }
  bound +=
    identifierCount * stats.entries +
    stats.identityWork +
    sortingWork(stats.entries);
  if (!Number.isSafeInteger(bound)) {
    panic("Screening work bound exceeds safe integer arithmetic");
  }
  return bound;
};
