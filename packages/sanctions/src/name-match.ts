import { panic } from "better-result";

import { distance } from "@stll/fuzzy-search";

import type { AliasQuality, EntityType, SanctionsEntry } from "./entry";
import { nameReading } from "./normalise";
import type { NameToken, NameReading } from "./normalise";

// One budget covers vocabulary lookups, postings and scoring across readings.
export const MAX_SCREENING_WORK = 2_000_000;
export type ScreeningWorkBudget = {
  remaining: number;
  exhausted: boolean;
  selection: "complete" | "partial";
};
export const spendScreeningWork = (
  budget: ScreeningWorkBudget,
  cost = 1,
): boolean => {
  if (budget.exhausted || cost > budget.remaining) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= cost;
  return true;
};
// A call, not a property read: callees spend the budget, so a narrowed
// `budget.exhausted` would go stale across them.
const screeningWorkExhausted = (budget: ScreeningWorkBudget): boolean =>
  budget.exhausted;

const MAX_SCORED_PATTERNS = 256;
const MAX_FUZZY_STRINGS = 64;

const METRIC = "damerau-levenshtein";

// Weights are inverse document frequencies over entries, so a shared
// "Mohammed" counts for less than a shared rare surname.
const INITIAL_WEIGHT = 1;
const INITIAL_SIMILARITY = 0.8;
// A listed middle name, patronymic or particle the query omits costs a quarter
// of its weight; any other listed token the query omits costs all of it.
const MIDDLE_NAME_DISCOUNT = 0.25;
const WEAK_ALIAS_FACTOR = 0.9;
const PATRONYMIC = /(?:ov|ev)(?:ic|ici|iti|na)$/u;
// Name particles, in folded form, that a query often drops.
const PARTICLES = new Set([
  "abd",
  "abu",
  "al",
  "ben",
  "bin",
  "bint",
  "da",
  "de",
  "der",
  "di",
  "du",
  "el",
  "ibn",
  "la",
  "le",
  "uld",
  "van",
  "von",
]);

/** Edit budget for a token pair, from the shorter token's length. */
const editBudget = (length: number): number => {
  if (length <= 3) {
    return 0;
  }
  return length <= 5 ? 1 : 2;
};

/**
 * Distinct strings of one spelling form, with a bigram index over them keyed
 * by string length, so a lookup only walks lengths within its edit budget.
 */
type Vocabulary = {
  strings: string[];
  /** Per string, its length in code points and its number of distinct bigrams. */
  lengths: number[];
  gramCounts: number[];
  /** Alternating Unicode code point and count pairs, one compact histogram per spelling. */
  characterCounts: Uint32Array[];
  ids: Map<string, number>;
  bigrams: Map<string, number[]>;
  /** Aliases that contain the string as a token. */
  postings: number[][];
  /** Aliases in which two adjacent tokens join into the string. */
  joinPostings: number[][];
  /** Reused by synchronous lookups; generations make clearing proportional to touched ids. */
  lookupScratch?: LookupScratch;
};

type LookupScratch = {
  counts: Uint32Array;
  generations: Uint32Array;
  generation: number;
  touched: number[];
  candidates: number[];
  queryCounts: Map<number, number>;
};

const MAX_LOOKUP_GENERATION = 0xff_ff_ff_ff;

const nextLookupScratch = (vocabulary: Vocabulary): LookupScratch => {
  let scratch = vocabulary.lookupScratch;
  if (scratch === undefined) {
    scratch = {
      counts: new Uint32Array(vocabulary.strings.length),
      generations: new Uint32Array(vocabulary.strings.length),
      generation: 0,
      touched: [],
      candidates: [],
      queryCounts: new Map(),
    };
    vocabulary.lookupScratch = scratch;
  }
  if (scratch.generation >= MAX_LOOKUP_GENERATION) {
    scratch.generations.fill(0);
    scratch.generation = 1;
  } else {
    scratch.generation += 1;
  }
  return scratch;
};

type IndexedAlias = {
  entry: number;
  name: string;
  quality: AliasQuality;
  entityType: EntityType;
  tokens: readonly NameToken[];
  /** Per token, its id in the folded and raw vocabularies. */
  folded: readonly number[];
  raw: readonly number[];
  /** Per adjacent token pair, the ids of the joined spelling. */
  joins: readonly {
    positions: readonly [number, number];
    folded: number;
    raw: number;
  }[];
  exactKey: string;
  patternKey: string;
};

export type NameIndex = {
  aliases: readonly IndexedAlias[];
  folded: Vocabulary;
  raw: Vocabulary;
  /** Inverse document frequency per folded id; join-only strings get the maximum. */
  weights: readonly number[];
  maxWeight: number;
};

const emptyVocabulary = (): Vocabulary => ({
  strings: [],
  lengths: [],
  gramCounts: [],
  characterCounts: [],
  ids: new Map(),
  bigrams: new Map(),
  postings: [],
  joinPostings: [],
});

const bigrams = (text: string): Set<string> => {
  const chars = ["^", ...Array.from(text), "$"];
  const grams = new Set<string>();
  for (const [index, char] of chars.entries()) {
    const previous = chars[index - 1];
    if (previous !== undefined) {
      grams.add(`${previous}${char}`);
    }
  }
  return grams;
};

const gramKey = (length: number, gram: string) => `${length}:${gram}`;

const characterHistogram = (
  text: string,
  counts = new Map<number, number>(),
): Map<number, number> => {
  counts.clear();
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      panic("Missing code point in character histogram");
    }
    counts.set(codePoint, (counts.get(codePoint) ?? 0) + 1);
  }
  return counts;
};

const compactCharacterCounts = (text: string): Uint32Array => {
  const sortedCounts = [...characterHistogram(text)].toSorted(
    ([left], [right]) => left - right,
  );
  const pairs: number[] = [];
  for (const [codePoint, count] of sortedCounts) {
    pairs.push(codePoint, count);
  }
  return Uint32Array.from(pairs);
};

const intern = (vocabulary: Vocabulary, text: string): number => {
  const known = vocabulary.ids.get(text);
  if (known !== undefined) {
    return known;
  }
  const id = vocabulary.strings.length;
  const grams = bigrams(text);
  const length = Array.from(text).length;
  vocabulary.strings.push(text);
  vocabulary.lengths.push(length);
  vocabulary.gramCounts.push(grams.size);
  vocabulary.characterCounts.push(compactCharacterCounts(text));
  vocabulary.ids.set(text, id);
  vocabulary.postings.push([]);
  vocabulary.joinPostings.push([]);
  for (const gram of grams) {
    const key = gramKey(length, gram);
    const ids = vocabulary.bigrams.get(key);
    if (ids === undefined) {
      vocabulary.bigrams.set(key, [id]);
    } else {
      ids.push(id);
    }
  }
  return id;
};

const post = (lists: number[][], ids: readonly number[], alias: number) => {
  for (const id of new Set(ids)) {
    lists[id]?.push(alias);
  }
};

/**
 * Builds the name index one entry at a time, pausing after each so a caller
 * on a serving event loop can give way between entries; see
 * {@link buildNameIndex} for the uninterrupted build.
 */
export function* nameIndexSteps(
  entries: readonly SanctionsEntry[],
): Generator<void, NameIndex, void> {
  let canShareVocabularies = true;
  for (const { names, entityType } of entries) {
    canShareVocabularies = names.every(({ name }) =>
      nameReading(name, entityType).tokens.every(
        ({ raw, folded }) => raw === folded,
      ),
    );
    if (!canShareVocabularies) {
      break;
    }
    yield;
  }
  const folded = emptyVocabulary();
  const raw = canShareVocabularies ? folded : emptyVocabulary();
  const aliases: IndexedAlias[] = [];
  const entryCounts = new Map<number, number>();

  for (const [entryIndex, entry] of entries.entries()) {
    const byKey = new Map<string, IndexedAlias>();
    const entryTokens = new Set<number>();
    for (const { name, quality } of entry.names) {
      const { tokens, adjacent } = nameReading(name, entry.entityType);
      const key = `${tokens.map((token) => token.raw).join(" ")}|${adjacent.join(";")}`;
      const existing = byKey.get(key);
      if (tokens.length === 0 || existing?.quality === "strong") {
        continue;
      }
      if (existing !== undefined) {
        // A weak alias the entry also lists as a strong one counts as strong.
        if (
          quality === "strong" ||
          (quality === "unknown" && existing.quality === "weak")
        ) {
          existing.quality = quality;
        }
        continue;
      }
      const alias: IndexedAlias = {
        entry: entryIndex,
        name,
        quality,
        entityType: entry.entityType,
        tokens,
        folded: tokens.map((token) => intern(folded, token.folded)),
        raw: tokens.map((token) => intern(raw, token.raw)),
        joins: adjacent.map((positions) => ({
          positions,
          folded: intern(
            folded,
            positions
              .map((position) => tokens[position]?.folded ?? "")
              .join(""),
          ),
          raw: intern(
            raw,
            positions.map((position) => tokens[position]?.raw ?? "").join(""),
          ),
        })),
        patternKey: `${entry.entityType}|${key}`,
        exactKey: tokens
          .map((token) => token.raw)
          .toSorted()
          .join(" "),
      };
      byKey.set(key, alias);
      post(folded.postings, alias.folded, aliases.length);
      if (raw !== folded) {
        post(raw.postings, alias.raw, aliases.length);
      }
      post(
        folded.joinPostings,
        alias.joins.map((join) => join.folded),
        aliases.length,
      );
      if (raw !== folded) {
        post(
          raw.joinPostings,
          alias.joins.map((join) => join.raw),
          aliases.length,
        );
      }
      for (const id of alias.folded) {
        entryTokens.add(id);
      }
      aliases.push(alias);
    }
    for (const id of entryTokens) {
      entryCounts.set(id, (entryCounts.get(id) ?? 0) + 1);
    }
    yield;
  }

  const maxWeight = Math.log(Math.max(entries.length, 1)) + 1;
  return {
    aliases,
    folded,
    raw,
    weights: folded.strings.map((_, id) => {
      const count = entryCounts.get(id);
      return count === undefined
        ? maxWeight
        : Math.log(entries.length / count) + 1;
    }),
    maxWeight,
  };
}

/** Runs a step generator to completion without pausing. */
export const runSteps = <T>(steps: Generator<void, T, void>): T => {
  for (;;) {
    const step = steps.next();
    if (step.done === true) {
      return step.value;
    }
  }
};

export const buildNameIndex = (entries: readonly SanctionsEntry[]): NameIndex =>
  runSteps(nameIndexSteps(entries));

/**
 * Vocabulary strings within the edit budget of `text`, with similarity
 * 1 - distance / longer length. A bigram count filter limits the exact edit
 * distance to a few candidates instead of the whole vocabulary: one edit (or
 * transposition) destroys at most three of a string's distinct bigrams, so a
 * string within budget k shares at least max(bigrams) - 3k of them.
 */
type CharacterDistanceOptions = {
  query: ReadonlyMap<number, number>;
  candidate: Uint32Array;
  lengthDifference: number;
};

const indexedCharacterCount = (
  counts: Uint32Array,
  codePoint: number,
): number => {
  let lower = 0;
  let upper = counts.length / 2;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const indexedCodePoint =
      counts.at(middle * 2) ?? panic("Missing indexed character code point");
    if (indexedCodePoint === codePoint) {
      return (
        counts.at(middle * 2 + 1) ?? panic("Missing indexed character count")
      );
    }
    if (indexedCodePoint < codePoint) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return 0;
};

// Transpositions preserve counts; other edits repair at most one deficit per side.
const characterDistanceLowerBound = ({
  query,
  candidate,
  lengthDifference,
}: CharacterDistanceOptions): number => {
  let missing = 0;
  for (const [codePoint, count] of query) {
    missing += Math.max(0, count - indexedCharacterCount(candidate, codePoint));
  }
  return Math.max(missing, lengthDifference + missing);
};

type SimilarStringsOptions = {
  vocabulary: Vocabulary;
  text: string;
  work: ScreeningWorkBudget;
};
const similarStrings = ({
  vocabulary,
  text,
  work,
}: SimilarStringsOptions): Map<number, number> => {
  const similar = new Map<number, number>();
  if (!spendScreeningWork(work, text.length + 1)) {
    return similar;
  }
  const exact = vocabulary.ids.get(text);
  if (exact !== undefined) {
    similar.set(exact, 1);
  }
  const length = Array.from(text).length;
  const budget = editBudget(length);
  if (budget === 0) {
    return similar;
  }
  const grams = bigrams(text);
  const scratch = nextLookupScratch(vocabulary);
  const counts = characterHistogram(text, scratch.queryCounts);
  const generation = scratch.generation;
  const { counts: sharedCounts, generations, touched, candidates } = scratch;
  touched.length = 0;
  candidates.length = 0;
  for (let other = length - budget; other <= length + budget; other += 1) {
    for (const gram of grams) {
      for (const id of vocabulary.bigrams.get(gramKey(other, gram)) ?? []) {
        if (!spendScreeningWork(work)) {
          return similar;
        }
        if (generations[id] !== generation) {
          generations[id] = generation;
          sharedCounts[id] = 0;
          touched.push(id);
        }
        sharedCounts[id] = (sharedCounts[id] ?? 0) + 1;
      }
    }
  }
  for (const id of touched) {
    if (!spendScreeningWork(work)) {
      return similar;
    }
    const candidateLength = vocabulary.lengths[id] ?? 0;
    const pairBudget = editBudget(Math.min(length, candidateLength));
    if (
      id === exact ||
      pairBudget === 0 ||
      Math.abs(candidateLength - length) > pairBudget ||
      (sharedCounts[id] ?? 0) <
        Math.max(grams.size, vocabulary.gramCounts[id] ?? 0) - 3 * pairBudget
    ) {
      continue;
    }
    const otherCounts =
      vocabulary.characterCounts[id] ??
      panic("Missing indexed character counts");
    if (
      characterDistanceLowerBound({
        query: counts,
        candidate: otherCounts,
        lengthDifference: candidateLength - length,
      }) > pairBudget
    ) {
      continue;
    }
    candidates.push(id);
  }
  if (
    !spendScreeningWork(
      work,
      candidates.length * Math.ceil(Math.log2(candidates.length + 1)),
    )
  ) {
    return similar;
  }
  candidates.sort(
    (left, right) =>
      (sharedCounts[right] ?? 0) /
        Math.max(grams.size, vocabulary.gramCounts[right] ?? 0) -
        (sharedCounts[left] ?? 0) /
          Math.max(grams.size, vocabulary.gramCounts[left] ?? 0) ||
      left - right,
  );
  if (candidates.length > MAX_FUZZY_STRINGS) {
    work.selection = "partial";
  }
  for (
    let index = 0;
    index < Math.min(candidates.length, MAX_FUZZY_STRINGS);
    index += 1
  ) {
    const id = candidates.at(index) ?? panic("Missing fuzzy candidate");
    const candidateLength = vocabulary.lengths[id] ?? 0;
    const pairBudget = editBudget(Math.min(length, candidateLength));
    if (!spendScreeningWork(work, length * candidateLength)) {
      return similar;
    }
    const edits = distance(text, vocabulary.strings[id] ?? "", METRIC);
    if (edits <= pairBudget) {
      similar.set(id, 1 - edits / Math.max(length, candidateLength));
    }
  }
  return similar;
};

/** One query token, or two adjacent ones read as a single word. */
type QueryUnit = {
  positions: readonly number[];
  folded: ReadonlyMap<number, number>;
  raw: ReadonlyMap<number, number>;
};

type PreparedQuery = {
  tokens: readonly NameToken[];
  weights: readonly number[];
  initials: readonly boolean[];
  units: readonly QueryUnit[];
};

const isInitial = (token: NameToken) => Array.from(token.raw).length === 1;

type QueryUnitOptions = {
  index: NameIndex;
  positions: readonly number[];
  token: NameToken;
  work: ScreeningWorkBudget;
};
const unit = ({
  index,
  positions,
  token,
  work,
}: QueryUnitOptions): QueryUnit | undefined => {
  const folded = similarStrings({
    vocabulary: index.folded,
    text: token.folded,
    work,
  });
  if (screeningWorkExhausted(work)) {
    return undefined;
  }
  if (index.raw === index.folded && token.raw === token.folded) {
    return { positions, folded, raw: folded };
  }
  const raw = similarStrings({ vocabulary: index.raw, text: token.raw, work });
  if (screeningWorkExhausted(work)) {
    return undefined;
  }
  return { positions, folded, raw };
};

type PrepareQueryOptions = {
  index: NameIndex;
  reading: NameReading;
  work: ScreeningWorkBudget;
};
const prepareQuery = ({
  index,
  reading: { tokens, adjacent },
  work,
}: PrepareQueryOptions): PreparedQuery | undefined => {
  if (!spendScreeningWork(work, tokens.length + adjacent.length)) {
    return undefined;
  }
  const initials = tokens.map(isInitial);
  const units: QueryUnit[] = [];
  const singles = new Map<number, QueryUnit>();
  for (const [position, token] of tokens.entries()) {
    if (!initials[position]) {
      const single = unit({ index, positions: [position], token, work });
      if (single === undefined) {
        return undefined;
      }
      units.push(single);
      singles.set(position, single);
    }
  }
  for (const positions of adjacent) {
    if (positions.some((position) => initials[position])) {
      continue;
    }
    const joined = unit({
      index,
      positions,
      token: {
        raw: positions.map((position) => tokens[position]?.raw ?? "").join(""),
        folded: positions
          .map((position) => tokens[position]?.folded ?? "")
          .join(""),
      },
      work,
    });
    if (joined === undefined) {
      return undefined;
    }
    units.push(joined);
  }
  const weights = initials.map((initial, position) => {
    if (initial) {
      return INITIAL_WEIGHT;
    }
    const single = singles.get(position);
    let weight = index.maxWeight;
    let best = -1;
    for (const [id, similarity] of single?.folded ?? []) {
      if (similarity > best && (index.folded.postings[id]?.length ?? 0) > 0) {
        best = similarity;
        weight = index.weights[id] ?? weight;
      }
    }
    return weight;
  });
  return { tokens, weights, initials, units };
};

type Pair = {
  /** "initial" pairs an initial with a word it abbreviates. */
  kind: "word" | "initial";
  query: readonly number[];
  listed: readonly number[];
  similarity: number;
};

const unitSimilarity = (
  queryUnit: QueryUnit,
  foldedId: number | undefined,
  rawId: number | undefined,
): number =>
  Math.max(
    foldedId === undefined ? 0 : (queryUnit.folded.get(foldedId) ?? 0),
    rawId === undefined ? 0 : (queryUnit.raw.get(rawId) ?? 0),
  );

/**
 * Every candidate pairing of query and listed tokens: whole words (either side
 * possibly two adjacent tokens read as one, "Abdul Rahman" against
 * "Abdulrahman") and initials against the words they abbreviate.
 */
const candidatePairs = (alias: IndexedAlias, query: PreparedQuery): Pair[] => {
  const pairs: Pair[] = [];
  for (const queryUnit of query.units) {
    for (let listed = 0; listed < alias.tokens.length; listed += 1) {
      const single = unitSimilarity(
        queryUnit,
        alias.folded[listed],
        alias.raw[listed],
      );
      if (single > 0) {
        pairs.push({
          kind: "word",
          query: queryUnit.positions,
          listed: [listed],
          similarity: single,
        });
      }
    }
    for (const join of alias.joins) {
      const similarity = unitSimilarity(queryUnit, join.folded, join.raw);
      if (similarity > 0) {
        pairs.push({
          kind: "word",
          query: queryUnit.positions,
          listed: join.positions,
          similarity,
        });
      }
    }
  }
  for (const [position, token] of query.tokens.entries()) {
    for (const [listed, listedToken] of alias.tokens.entries()) {
      const queryInitial = query.initials[position] === true;
      const listedInitial = listedToken.raw.length === 1;
      if (queryInitial && listedToken.raw.startsWith(token.raw)) {
        pairs.push({
          kind: "initial",
          query: [position],
          listed: [listed],
          similarity: listedInitial ? 1 : INITIAL_SIMILARITY,
        });
      } else if (
        !queryInitial &&
        listedInitial &&
        token.raw.startsWith(listedToken.raw)
      ) {
        pairs.push({
          kind: "initial",
          query: [position],
          listed: [listed],
          similarity: INITIAL_SIMILARITY,
        });
      }
    }
  }
  return pairs;
};

type Alignment = {
  /** Similarity per matched query and listed token position. */
  query: Map<number, number>;
  listed: Map<number, number>;
  /** Whether at least one whole word matched, not only initials. */
  anchored: boolean;
};

/** Greedy one-to-one alignment: best pair first, then the one covering more. */
const align = (pairs: Pair[]): Alignment => {
  pairs.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      right.query.length +
        right.listed.length -
        left.query.length -
        left.listed.length,
  );
  const alignment: Alignment = {
    query: new Map(),
    listed: new Map(),
    anchored: false,
  };
  for (const pair of pairs) {
    if (
      pair.query.some((position) => alignment.query.has(position)) ||
      pair.listed.some((position) => alignment.listed.has(position))
    ) {
      continue;
    }
    for (const position of pair.query) {
      alignment.query.set(position, pair.similarity);
    }
    for (const position of pair.listed) {
      alignment.listed.set(position, pair.similarity);
    }
    alignment.anchored ||= pair.kind === "word";
  }
  return alignment;
};

/** Shares of the listed name's weight for ranking and optimistic filtering. */
type ListedCoverageOptions = {
  index: NameIndex;
  alias: IndexedAlias;
  matched: ReadonlyMap<number, number>;
};
const listedCoverage = ({ index, alias, matched }: ListedCoverageOptions) => {
  let alignedTotal = 0;
  let minimumTotal = 0;
  let explained = 0;
  const last = alias.tokens.length - 1;
  for (const [listed, token] of alias.tokens.entries()) {
    const weight =
      token.raw.length === 1
        ? INITIAL_WEIGHT
        : (index.weights[alias.folded[listed] ?? -1] ?? index.maxWeight);
    const optional =
      alias.entityType === "person" &&
      ((listed > 0 && listed < last) ||
        PATRONYMIC.test(token.folded) ||
        PARTICLES.has(token.folded));
    const minimumWeight = optional ? weight * MIDDLE_NAME_DISCOUNT : weight;
    minimumTotal += minimumWeight;
    const similarity = matched.get(listed);
    alignedTotal += similarity === undefined ? minimumWeight : weight;
    if (similarity !== undefined) {
      explained += weight * similarity;
    }
  }
  return {
    minimum: Math.min(1, explained / minimumTotal),
    aligned: Math.min(1, explained / alignedTotal),
  };
};

/**
 * Order-independent name score: the geometric mean of how much of the query
 * and of the listed name the alignment explains, weighted by token rarity.
 */
const scoreAlias = (
  index: NameIndex,
  alias: IndexedAlias,
  query: PreparedQuery,
): number => {
  const alignment = align(candidatePairs(alias, query));
  // Initials alone never make a match: "A.B.C." is not "Alpha Beta Charlie".
  if (!alignment.anchored) {
    return 0;
  }
  let queryTotal = 0;
  let queryExplained = 0;
  for (const [position, weight] of query.weights.entries()) {
    queryTotal += weight;
    queryExplained += weight * (alignment.query.get(position) ?? 0);
  }
  const score = Math.sqrt(
    (queryExplained / queryTotal) *
      listedCoverage({
        index,
        alias,
        matched: alignment.listed,
      }).aligned,
  );
  return alias.quality === "weak" ? score * WEAK_ALIAS_FACTOR : score;
};

type CandidateEstimate = { bound: number; rank: number };
type CandidateEstimateOptions = {
  index: NameIndex;
  alias: IndexedAlias;
  query: PreparedQuery;
};
const candidateEstimate = ({
  index,
  alias,
  query,
}: CandidateEstimateOptions): CandidateEstimate => {
  const single = query.units.at(0);
  if (
    query.tokens.length === 1 &&
    query.units.length === 1 &&
    single !== undefined &&
    alias.joins.every(
      (join) => unitSimilarity(single, join.folded, join.raw) === 0,
    )
  ) {
    const matched = new Map<number, number>();
    let similarity = 0;
    for (let position = 0; position < alias.tokens.length; position += 1) {
      const current = unitSimilarity(
        single,
        alias.folded[position],
        alias.raw[position],
      );
      if (current === 0) {
        continue;
      }
      similarity = Math.max(similarity, current);
      matched.set(position, current);
    }
    const coverage = listedCoverage({ index, alias, matched });
    return {
      bound: Math.sqrt(similarity * coverage.minimum),
      rank: Math.sqrt(similarity * coverage.aligned),
    };
  }
  const pairs = candidatePairs(alias, query);
  if (!pairs.some((pair) => pair.kind === "word")) {
    return { bound: 0, rank: 0 };
  }
  const queryMatched = new Map<number, number>();
  const listedMatched = new Map<number, number>();
  for (const pair of pairs) {
    for (const position of pair.query) {
      queryMatched.set(
        position,
        Math.max(queryMatched.get(position) ?? 0, pair.similarity),
      );
    }
    for (const position of pair.listed) {
      listedMatched.set(
        position,
        Math.max(listedMatched.get(position) ?? 0, pair.similarity),
      );
    }
  }
  let queryTotal = 0;
  let queryExplained = 0;
  for (const [position, weight] of query.weights.entries()) {
    queryTotal += weight;
    queryExplained += weight * (queryMatched.get(position) ?? 0);
  }
  const queryShare = queryExplained / queryTotal;
  const coverage = listedCoverage({ index, alias, matched: listedMatched });
  return {
    bound: Math.sqrt(queryShare * coverage.minimum),
    rank: Math.sqrt(queryShare * coverage.aligned),
  };
};

export type NameMatches = {
  matches: Map<number, NameMatch>;
  truncated: boolean;
};

export type NameMatch = { score: number; name: string };

/**
 * Best name score per entry index. `ceiling` maps the largest share of the
 * query weight an alias could explain to the best final score it could still
 * reach; aliases whose ceiling is below `cutoff` are skipped unscored.
 */
type CandidateGroup = {
  aliasIndices: [number, ...number[]];
  bound: number;
  rank: number;
  exact: boolean;
};

type MatchNamesOptions = {
  index: NameIndex;
  reading: NameReading;
  ceiling: (queryShare: number) => number;
  rankEntry: (entry: number, nameScore: number) => number | undefined;
  cutoff: number;
  work: ScreeningWorkBudget;
};
type RankCandidateGroupsOptions = {
  index: NameIndex;
  query: PreparedQuery;
  reachedWeight: ReadonlyMap<number, number>;
  initialWeight: number;
  totalWeight: number;
  ceiling: (share: number) => number;
  rankEntry: MatchNamesOptions["rankEntry"];
  cutoff: number;
  work: ScreeningWorkBudget;
};

const rankCandidateGroups = ({
  index,
  query,
  reachedWeight,
  initialWeight,
  totalWeight,
  ceiling,
  rankEntry,
  cutoff,
  work,
}: RankCandidateGroupsOptions): CandidateGroup[] | undefined => {
  const byPattern = new Map<string, CandidateGroup>();
  const estimates = new Map<string, CandidateEstimate>();
  const exactKey = query.tokens
    .map((token) => token.raw)
    .toSorted()
    .join(" ");
  for (const [aliasIndex, weight] of reachedWeight) {
    if (!spendScreeningWork(work)) {
      return undefined;
    }
    if (ceiling((weight + initialWeight) / totalWeight) < cutoff) {
      continue;
    }
    const alias =
      index.aliases[aliasIndex] ?? panic("Missing reached candidate alias");
    const exact = alias.exactKey === exactKey;
    let estimate = exact
      ? { bound: 1, rank: 1 }
      : estimates.get(alias.patternKey);
    if (estimate === undefined) {
      const pairWork =
        query.units.length * (alias.tokens.length + alias.joins.length) +
        query.tokens.length * alias.tokens.length;
      if (!spendScreeningWork(work, pairWork)) {
        return undefined;
      }
      estimate = candidateEstimate({ index, alias, query });
    }
    estimates.set(alias.patternKey, estimate);
    const bound = ceiling(estimate.bound * estimate.bound);
    if (bound < cutoff) {
      continue;
    }
    const rank = rankEntry(
      alias.entry,
      estimate.rank * (alias.quality === "weak" ? WEAK_ALIAS_FACTOR : 1),
    );
    if (rank === undefined) {
      return undefined;
    }
    const groupKey = `${alias.patternKey}|${alias.quality}`;
    const group = byPattern.get(groupKey);
    if (group === undefined) {
      byPattern.set(groupKey, {
        aliasIndices: [aliasIndex],
        bound,
        rank,
        exact,
      });
    } else {
      group.aliasIndices.push(aliasIndex);
      group.rank = Math.max(group.rank, rank);
    }
  }
  const candidates = [...byPattern.values()];
  if (
    !spendScreeningWork(
      work,
      candidates.length * Math.ceil(Math.log2(candidates.length + 1)),
    )
  ) {
    return undefined;
  }
  candidates.sort(
    (left, right) =>
      Number(right.exact) - Number(left.exact) ||
      right.rank - left.rank ||
      right.bound - left.bound ||
      left.aliasIndices[0] - right.aliasIndices[0],
  );
  return candidates;
};

export const matchNames = ({
  index,
  reading,
  ceiling,
  rankEntry,
  cutoff,
  work,
}: MatchNamesOptions): NameMatches | undefined => {
  const query = prepareQuery({ index, reading, work });
  if (query === undefined) {
    return undefined;
  }
  const reachedWeight = new Map<number, number>();
  let initialWeight = 0;
  let totalWeight = 0;
  for (const [position, weight] of query.weights.entries()) {
    totalWeight += weight;
    if (query.initials[position]) {
      // Initials match by prefix at scoring time, so every alias may use them.
      initialWeight += weight;
      continue;
    }
    const reached = new Set<number>();
    for (const queryUnit of query.units) {
      if (!queryUnit.positions.includes(position)) {
        continue;
      }
      for (const [vocabulary, similar] of [
        [index.folded, queryUnit.folded],
        [index.raw, queryUnit.raw],
      ] as const) {
        for (const id of similar.keys()) {
          for (const alias of vocabulary.postings[id] ?? []) {
            if (!spendScreeningWork(work)) {
              return undefined;
            }
            reached.add(alias);
          }
          for (const alias of vocabulary.joinPostings[id] ?? []) {
            if (!spendScreeningWork(work)) {
              return undefined;
            }
            reached.add(alias);
          }
        }
      }
    }
    for (const alias of reached) {
      if (!spendScreeningWork(work)) {
        return undefined;
      }
      reachedWeight.set(alias, (reachedWeight.get(alias) ?? 0) + weight);
    }
  }

  const candidates = rankCandidateGroups({
    index,
    query,
    reachedWeight,
    initialWeight,
    totalWeight,
    ceiling,
    rankEntry,
    cutoff,
    work,
  });
  if (candidates === undefined) {
    return undefined;
  }
  const best = new Map<number, NameMatch>();
  const selected = [
    ...candidates.filter((candidate) => candidate.exact),
    ...candidates
      .filter((candidate) => !candidate.exact)
      .slice(0, MAX_SCORED_PATTERNS),
  ];
  for (const { aliasIndices, exact } of selected) {
    const alias =
      index.aliases[aliasIndices[0]] ??
      panic("Missing selected candidate alias");
    let score = alias.quality === "weak" ? WEAK_ALIAS_FACTOR : 1;
    if (!exact) {
      const pairs =
        query.units.length * (alias.tokens.length + alias.joins.length) +
        query.tokens.length * alias.tokens.length;
      if (
        !spendScreeningWork(
          work,
          pairs * Math.max(1, Math.ceil(Math.log2(pairs + 1))) +
            alias.tokens.length,
        )
      ) {
        return undefined;
      }
      score = scoreAlias(index, alias, query);
    }
    for (const aliasIndex of aliasIndices) {
      if (!spendScreeningWork(work)) {
        return undefined;
      }
      const member =
        index.aliases[aliasIndex] ?? panic("Missing grouped candidate alias");
      const current = best.get(member.entry);
      if (score > 0 && (current === undefined || score > current.score)) {
        best.set(member.entry, { score, name: member.name });
      }
    }
  }
  return {
    matches: best,
    truncated:
      work.selection === "partial" || selected.length < candidates.length,
  };
};
