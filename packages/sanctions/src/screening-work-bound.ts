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
  identityWork: number;
  postings: number;
};

function* vocabularyStats(
  vocabulary: NameIndex["folded"],
): Generator<undefined, VocabularyWorkStats, void> {
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
): Generator<undefined, ScreeningWorkStats, void> {
  const folded = yield* vocabularyStats(names.folded);
  const raw =
    names.raw === names.folded ? folded : yield* vocabularyStats(names.raw);
  let maxAliasTokens = 0;
  let maxAliasUnits = 0;
  let aliasUnits = 0;
  for (let id = 0; id < names.aliases.length; id += 1) {
    const alias = names.aliases.metadata(id);
    const units = alias.raw.length + 2 * alias.joins.length;
    maxAliasTokens = Math.max(maxAliasTokens, alias.raw.length);
    maxAliasUnits = Math.max(maxAliasUnits, units);
    aliasUnits += units;
    if (id % 4096 === 0) {
      yield;
    }
  }
  let identityWork = 0;
  for (let id = 0; id < entries.length; id += 1) {
    const entry = entries.get(id);
    const cost =
      entry.birthDates.length +
      entry.nationalities.length +
      entry.identifiers.length +
      1;
    identityWork += cost;
    if (id % 4096 === 0) {
      yield;
    }
  }
  return {
    folded,
    raw,
    postings: names.entities.postingCount,
    aliases: names.aliases.length,
    maxAliasTokens,
    maxAliasUnits,
    aliasUnits,
    entries: entries.length,
    identityWork,
  };
}

const sortingWork = (count: number) => count * Math.ceil(Math.log2(count + 1));

// A full lexicon traversal visits at most every scalar cell of every spelling.
// Include verification with the sanctions metric independently of index pruning.
const lookupWork = (length: number, vocabulary: VocabularyWorkStats): number =>
  16 * vocabulary.strings * (length + 1) * (vocabulary.maxLength + 1);

type ScreeningWorkBoundOptions = {
  stats: ScreeningWorkStats;
  readings: readonly NameReading[];
  identifierCount: number;
};

/** Complete traversal bound from edition dimensions and validated input.
 * Both forms, every posting (including repeated join endpoints), every alias
 * alignment and final identity/ranking pass fit even when pruning saves no work.
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
    // Sorted posting accesses and random bound evaluation, including both
    // endpoints of self joins. No assumption about selectivity or fanout.
    bound +=
      16 *
      (units + tokens + 1) *
      (stats.postings + stats.aliases * (pairs + 1));
    for (const token of reading.tokens) {
      bound +=
        lookupWork(token.folded.length, stats.folded) +
        lookupWork(token.raw.length, stats.raw);
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
        lookupWork(foldedLength, stats.folded) +
        lookupWork(rawLength, stats.raw);
    }
    // Two vocabulary paths, one visit per position covered by each unit.
    bound += 2 * (tokens + 2 * reading.adjacent.length) * stats.aliasUnits;
    bound += tokens * stats.aliases;
    bound += stats.aliases * (1 + pairs);
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
