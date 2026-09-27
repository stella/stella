import { distance } from "@stll/fuzzy-search";

import type { AliasQuality, EntityType, SanctionsEntry } from "./entry";
import { nameTokens } from "./normalise";
import type { NameToken } from "./normalise";

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
  ids: Map<string, number>;
  bigrams: Map<string, number[]>;
  /** Aliases that contain the string as a token. */
  postings: number[][];
  /** Aliases in which two adjacent tokens join into the string. */
  joinPostings: number[][];
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
  foldedJoins: readonly number[];
  rawJoins: readonly number[];
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
  ids: new Map(),
  bigrams: new Map(),
  postings: [],
  joinPostings: [],
});

const bigrams = (text: string): Set<string> => {
  const chars = ["^", ...text, "$"];
  const grams = new Set<string>();
  for (let index = 1; index < chars.length; index += 1) {
    grams.add(`${chars[index - 1]}${chars[index]}`);
  }
  return grams;
};

const gramKey = (length: number, gram: string) => `${length}:${gram}`;

const intern = (vocabulary: Vocabulary, text: string): number => {
  const known = vocabulary.ids.get(text);
  if (known !== undefined) {
    return known;
  }
  const id = vocabulary.strings.length;
  const grams = bigrams(text);
  const length = [...text].length;
  vocabulary.strings.push(text);
  vocabulary.lengths.push(length);
  vocabulary.gramCounts.push(grams.size);
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

const joins = (tokens: readonly NameToken[], form: keyof NameToken): string[] =>
  tokens
    .slice(1)
    .map((token, index) => `${tokens[index]?.[form] ?? ""}${token[form]}`);

export const buildNameIndex = (
  entries: readonly SanctionsEntry[],
): NameIndex => {
  const folded = emptyVocabulary();
  const raw = emptyVocabulary();
  const aliases: IndexedAlias[] = [];
  const entryCounts = new Map<number, number>();

  for (const [entryIndex, entry] of entries.entries()) {
    const byKey = new Map<string, IndexedAlias>();
    const entryTokens = new Set<number>();
    for (const { name, quality } of entry.names) {
      const tokens = nameTokens(name, entry.entityType);
      const key = tokens.map((token) => token.raw).join(" ");
      const existing = byKey.get(key);
      if (tokens.length === 0 || existing?.quality === "strong") {
        continue;
      }
      if (existing !== undefined) {
        // A weak alias the entry also lists as a strong one counts as strong.
        existing.quality = quality;
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
        foldedJoins: joins(tokens, "folded").map((text) =>
          intern(folded, text),
        ),
        rawJoins: joins(tokens, "raw").map((text) => intern(raw, text)),
      };
      byKey.set(key, alias);
      post(folded.postings, alias.folded, aliases.length);
      post(raw.postings, alias.raw, aliases.length);
      post(folded.joinPostings, alias.foldedJoins, aliases.length);
      post(raw.joinPostings, alias.rawJoins, aliases.length);
      for (const id of alias.folded) {
        entryTokens.add(id);
      }
      aliases.push(alias);
    }
    for (const id of entryTokens) {
      entryCounts.set(id, (entryCounts.get(id) ?? 0) + 1);
    }
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
};

/**
 * Vocabulary strings within the edit budget of `text`, with similarity
 * 1 - distance / longer length. A bigram count filter limits the exact edit
 * distance to a few candidates instead of the whole vocabulary: one edit (or
 * transposition) destroys at most three of a string's distinct bigrams, so a
 * string within budget k shares at least max(bigrams) - 3k of them.
 */
const similarStrings = (
  vocabulary: Vocabulary,
  text: string,
): Map<number, number> => {
  const similar = new Map<number, number>();
  const exact = vocabulary.ids.get(text);
  if (exact !== undefined) {
    similar.set(exact, 1);
  }
  const length = [...text].length;
  const budget = editBudget(length);
  if (budget === 0) {
    return similar;
  }
  const grams = bigrams(text);
  const shared = new Uint16Array(vocabulary.strings.length);
  const touched: number[] = [];
  for (let other = length - budget; other <= length + budget; other += 1) {
    for (const gram of grams) {
      for (const id of vocabulary.bigrams.get(gramKey(other, gram)) ?? []) {
        if (shared[id] === 0) {
          touched.push(id);
        }
        shared[id] = (shared[id] ?? 0) + 1;
      }
    }
  }
  for (const id of touched) {
    const candidateLength = vocabulary.lengths[id] ?? 0;
    const pairBudget = editBudget(Math.min(length, candidateLength));
    if (
      id === exact ||
      pairBudget === 0 ||
      Math.abs(candidateLength - length) > pairBudget ||
      (shared[id] ?? 0) <
        Math.max(grams.size, vocabulary.gramCounts[id] ?? 0) - 3 * pairBudget
    ) {
      continue;
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

const isInitial = (token: NameToken) => [...token.raw].length === 1;

const unit = (
  index: NameIndex,
  positions: readonly number[],
  token: NameToken,
): QueryUnit => ({
  positions,
  folded: similarStrings(index.folded, token.folded),
  raw: similarStrings(index.raw, token.raw),
});

const prepareQuery = (
  index: NameIndex,
  tokens: readonly NameToken[],
): PreparedQuery => {
  const initials = tokens.map(isInitial);
  const units: QueryUnit[] = [];
  for (const [position, token] of tokens.entries()) {
    if (!initials[position]) {
      units.push(unit(index, [position], token));
    }
    const next = tokens[position + 1];
    if (next !== undefined && !initials[position] && !isInitial(next)) {
      units.push(
        unit(index, [position, position + 1], {
          raw: `${token.raw}${next.raw}`,
          folded: `${token.folded}${next.folded}`,
        }),
      );
    }
  }
  const weights = tokens.map((token, position) => {
    if (initials[position]) {
      return INITIAL_WEIGHT;
    }
    const single = units.find(
      (candidate) =>
        candidate.positions.length === 1 && candidate.positions[0] === position,
    );
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
      const joined = unitSimilarity(
        queryUnit,
        alias.foldedJoins[listed],
        alias.rawJoins[listed],
      );
      if (joined > 0) {
        pairs.push({
          kind: "word",
          query: queryUnit.positions,
          listed: [listed, listed + 1],
          similarity: joined,
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

/** Share of the listed name's weight the alignment explains. */
const listedCoverage = (
  index: NameIndex,
  alias: IndexedAlias,
  matched: ReadonlyMap<number, number>,
): number => {
  let total = 0;
  let explained = 0;
  const last = alias.tokens.length - 1;
  for (const [listed, token] of alias.tokens.entries()) {
    const weight =
      token.raw.length === 1
        ? INITIAL_WEIGHT
        : (index.weights[alias.folded[listed] ?? -1] ?? index.maxWeight);
    const similarity = matched.get(listed);
    if (similarity !== undefined) {
      total += weight;
      explained += weight * similarity;
      continue;
    }
    const optional =
      alias.entityType === "person" &&
      ((listed > 0 && listed < last) ||
        PATRONYMIC.test(token.folded) ||
        PARTICLES.has(token.folded));
    total += optional ? weight * MIDDLE_NAME_DISCOUNT : weight;
  }
  return explained / total;
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
      listedCoverage(index, alias, alignment.listed),
  );
  return alias.quality === "weak" ? score * WEAK_ALIAS_FACTOR : score;
};

export type NameMatch = { score: number; name: string };

/**
 * Best name score per entry index. `ceiling` maps the largest share of the
 * query weight an alias could explain to the best final score it could still
 * reach; aliases whose ceiling is below `cutoff` are skipped unscored.
 */
export const matchNames = (
  index: NameIndex,
  tokens: readonly NameToken[],
  ceiling: (queryShare: number) => number,
  cutoff: number,
): Map<number, NameMatch> => {
  const query = prepareQuery(index, tokens);
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
            reached.add(alias);
          }
          for (const alias of vocabulary.joinPostings[id] ?? []) {
            reached.add(alias);
          }
        }
      }
    }
    for (const alias of reached) {
      reachedWeight.set(alias, (reachedWeight.get(alias) ?? 0) + weight);
    }
  }

  const best = new Map<number, NameMatch>();
  for (const [aliasIndex, weight] of reachedWeight) {
    if (ceiling((weight + initialWeight) / totalWeight) < cutoff) {
      continue;
    }
    const alias = index.aliases[aliasIndex];
    if (alias === undefined) {
      continue;
    }
    const score = scoreAlias(index, alias, query);
    const current = best.get(alias.entry);
    if (score > 0 && (current === undefined || score > current.score)) {
      best.set(alias.entry, { score, name: alias.name });
    }
  }
  return best;
};
