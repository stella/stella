import { panic } from "better-result";

import { EntityIndexBuilder } from "@stll/fuzzy-search";
import type {
  EntityIndex,
  EntityQuery,
  EntitySearchResult,
} from "@stll/fuzzy-search";

import {
  type SpellingColumn,
  spellingColumnSteps,
  NumberColumn,
  ObjectColumn,
  StringMap,
} from "./compact-storage";
import type { AliasQuality, EntityType, SanctionsEntry } from "./entry";
import { nameReading } from "./normalise";
import type { NameToken, NameReading } from "./normalise";

export type ScreeningWorkBudget = {
  remaining: number;
  exhausted: boolean;
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

// Spelling lookups decode one string per access; direct-mapped slots keep a
// hot vocabulary decoded without growing with every distinct query.
const SPELLING_CACHE_LIMIT = 16_384;
// Aliases added to the entity index between pauses of a cooperative build.
const ALIAS_STEP = 256;

const FORM = { folded: 0, raw: 1 } as const;
type Form = (typeof FORM)[keyof typeof FORM];
// Shorter-token length in Unicode scalars -> allowed Damerau-Levenshtein
// (optimal string alignment) edits: none up to three, one up to five, then two.
const EDIT_BUDGET = {
  byLength: [0, 0, 0, 0, 1, 1, 2],
  basis: "shorter",
} as const;
// Candidate bounds never exceed one, so this threshold reads the lexicon only.
const LEXICON_ONLY_TAU = 2;
// Weak and strong aliases enter the index alike; quality applies once, in
// final scoring, so the candidate bound stays an upper bound for both.
const INDEX_QUALITY = 1;

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

type Spellings = { strings: ObjectColumn<string> | SpellingColumn };

class VocabularyStrings {
  private readonly cacheIds = new Uint32Array(SPELLING_CACHE_LIMIT);
  private readonly cacheStrings: (string | undefined)[] = Array.from(
    { length: SPELLING_CACHE_LIMIT },
    () => undefined,
  );
  private readonly spellings;
  private readonly ids;
  constructor(spellings: Spellings, ids: NumberColumn) {
    this.spellings = spellings;
    this.ids = ids;
  }
  get length(): number {
    return this.ids.length;
  }
  get(id: number): string {
    const slot = id % SPELLING_CACHE_LIMIT;
    if (this.cacheIds[slot] === id + 1) {
      return (
        this.cacheStrings[slot] ?? panic("Missing cached vocabulary spelling")
      );
    }
    const spelling = this.spellings.strings.get(this.ids.get(id));
    this.cacheIds[slot] = id + 1;
    this.cacheStrings[slot] = spelling;
    return spelling;
  }
}

/** One spelling form's strings, in the entity index's caller-order ids. */
type Vocabulary = {
  strings: { readonly length: number; get: (id: number) => string };
  /** Sum of UTF-16 lengths, an upper bound on Unicode scalars. */
  characters: number;
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
  /** Per original adjacent pair, after deduplication, the joined spelling's ids. */
  joins: readonly {
    positions: readonly [number, number];
    folded: number;
    raw: number;
  }[];
  patternKey: string;
};

const QUALITIES = [
  "strong",
  "weak",
  "unknown",
] as const satisfies readonly AliasQuality[];

type AliasMetadata = Omit<IndexedAlias, "name" | "tokens">;

type AliasColumnOptions = {
  folded: Vocabulary["strings"];
  raw: Vocabulary["strings"];
};
class AliasColumn {
  private readonly names = new ObjectColumn<string>();
  private readonly entries = new NumberColumn();
  private readonly qualities = new NumberColumn();
  private readonly entityTypes = new ObjectColumn<EntityType>();
  private readonly tokenOffsets = new NumberColumn();
  private readonly joinOffsets = new NumberColumn();
  private readonly tokenIds = new NumberColumn();
  private readonly joinIds = new NumberColumn();

  private readonly folded;
  private readonly raw;
  constructor({ folded, raw }: AliasColumnOptions) {
    this.folded = folded;
    this.raw = raw;
    this.tokenOffsets.push(0);
    this.joinOffsets.push(0);
  }

  get length(): number {
    return this.names.length;
  }

  setQuality(id: number, quality: AliasQuality): void {
    this.qualities.set(id, QUALITIES.indexOf(quality));
  }

  push(alias: IndexedAlias): number {
    const id = this.names.push(alias.name);
    this.entries.push(alias.entry);
    this.qualities.push(QUALITIES.indexOf(alias.quality));
    this.entityTypes.push(alias.entityType);
    for (let position = 0; position < alias.tokens.length; position += 1) {
      this.tokenIds.push(
        alias.folded[position] ?? panic("Missing folded token"),
      );
      this.tokenIds.push(alias.raw[position] ?? panic("Missing raw token"));
    }
    for (const join of alias.joins) {
      this.joinIds.push(join.positions[0]);
      this.joinIds.push(join.positions[1]);
      this.joinIds.push(join.folded);
      this.joinIds.push(join.raw);
    }
    this.tokenOffsets.push(this.tokenIds.length);
    this.joinOffsets.push(this.joinIds.length);
    return id;
  }

  metadata(id: number): AliasMetadata {
    const folded: number[] = [];
    const raw: number[] = [];
    const joins: IndexedAlias["joins"][number][] = [];
    const tokenEnd = this.tokenOffsets.get(id + 1);
    for (
      let offset = this.tokenOffsets.get(id);
      offset < tokenEnd;
      offset += 2
    ) {
      folded.push(this.tokenIds.getUnchecked(offset));
      raw.push(this.tokenIds.getUnchecked(offset + 1));
    }
    const joinEnd = this.joinOffsets.get(id + 1);
    for (let offset = this.joinOffsets.get(id); offset < joinEnd; offset += 4) {
      joins.push({
        positions: [
          this.joinIds.getUnchecked(offset),
          this.joinIds.getUnchecked(offset + 1),
        ],
        folded: this.joinIds.getUnchecked(offset + 2),
        raw: this.joinIds.getUnchecked(offset + 3),
      });
    }
    const entityType = this.entityTypes.get(id);
    const key = `${raw.join(",")}|${joins.map((join) => join.positions.join(",")).join(";")}`;
    return {
      entry: this.entries.get(id),
      quality:
        QUALITIES[this.qualities.get(id)] ?? panic("Missing alias quality"),
      entityType,
      folded,
      raw,
      joins,
      patternKey: `${entityType}|${key}`,
    };
  }

  get(id: number): IndexedAlias {
    const metadata = this.metadata(id);
    const tokens = metadata.raw.map((rawId, position) => ({
      folded: this.folded.get(
        metadata.folded[position] ?? panic("Missing folded token"),
      ),
      raw: this.raw.get(rawId),
    }));
    return { ...metadata, name: this.names.get(id), tokens };
  }
}

/** Edition dimensions that bound one screening's work; see {@link nameWorkBound}. */
export type NameIndexStats = {
  aliases: number;
  /** Sum over aliases of their tokens plus joined pairs, in one form. */
  aliasUnits: number;
  maxAliasTokens: number;
  maxAliasUnits: number;
  postings: number;
  forms: readonly [Vocabulary, Vocabulary];
};

export type NameIndex = {
  aliases: AliasColumn;
  folded: Vocabulary;
  raw: Vocabulary;
  /** Inverse document frequency per folded id. */
  weights: NumberColumn;
  /** Per folded id, the aliases listing it as a token and as a joined pair. */
  tokenAliases: NumberColumn;
  joinAliases: NumberColumn;
  maxWeight: number;
  candidates: EntityIndex;
  stats: NameIndexStats;
};

type ListedWeight = { weight: number; minimumWeight: number };
type ListedWeightsOptions = {
  entityType: EntityType;
  tokens: readonly NameToken[];
  idf: (position: number) => number;
};

/**
 * Listed position weights, shared by the entity index's candidate bound and
 * final scoring so the two cannot disagree.
 */
const listedWeights = ({
  entityType,
  tokens,
  idf,
}: ListedWeightsOptions): ListedWeight[] => {
  const last = tokens.length - 1;
  return tokens.map((token, position) => {
    const weight = token.raw.length === 1 ? INITIAL_WEIGHT : idf(position);
    const optional =
      entityType === "person" &&
      ((position > 0 && position < last) ||
        PATRONYMIC.test(token.folded) ||
        PARTICLES.has(token.folded));
    return {
      weight,
      minimumWeight: optional ? weight * MIDDLE_NAME_DISCOUNT : weight,
    };
  });
};

const aliasWeights = (weights: NumberColumn, alias: IndexedAlias) =>
  listedWeights({
    entityType: alias.entityType,
    tokens: alias.tokens,
    idf: (position) =>
      weights.get(alias.folded[position] ?? panic("Missing folded token")),
  });

type BuildingVocabulary = {
  form: Form;
  spellingIds: NumberColumn;
  strings: VocabularyStrings;
  characters: number;
};

type InternOptions = {
  builder: EntityIndexBuilder;
  vocabulary: BuildingVocabulary;
  spellings: Spellings;
  /** Build-only: each distinct text's spelling id, shared by both forms. */
  spellingIds: StringMap<number>;
  text: string;
};
const intern = ({
  builder,
  vocabulary,
  spellings,
  spellingIds,
  text,
}: InternOptions): number => {
  const id = builder.intern(vocabulary.form, text);
  if (id < vocabulary.spellingIds.length) {
    return id;
  }
  if (id !== vocabulary.spellingIds.length) {
    panic("Entity index interned a spelling out of caller order");
  }
  let spelling = spellingIds.get(text);
  if (spelling === undefined) {
    if (!(spellings.strings instanceof ObjectColumn)) {
      return panic("Spelling column was already packed");
    }
    spelling = spellings.strings.push(text);
    spellingIds.set(text, spelling);
  }
  vocabulary.spellingIds.push(spelling);
  vocabulary.characters += text.length;
  return id;
};

const growTo = (column: NumberColumn, length: number) => {
  while (column.length < length) {
    column.push(0);
  }
};

const increment = (column: NumberColumn, ids: Iterable<number>) => {
  for (const id of new Set(ids)) {
    column.set(id, column.get(id) + 1);
  }
};

/**
 * The entity index's last construction units each take a long single step on
 * a large edition, so a serving caller finishes them on the native worker pool.
 */
export type PendingNameIndex = {
  finish: () => NameIndex;
  finishAsync: () => Promise<NameIndex>;
};

/**
 * Prepares the name index one entry at a time, pausing after each so a caller
 * on a serving event loop can give way between entries; see
 * {@link buildNameIndex} for the uninterrupted build.
 * @yields Control between entries and alias batches.
 */
export function* nameIndexSteps(
  entries: Iterable<SanctionsEntry> & {
    readonly length: number;
    entries: () => Iterable<[number, SanctionsEntry]>;
  },
): Generator<void, PendingNameIndex, void> {
  const builder = new EntityIndexBuilder({
    forms: 2,
    budget: { byLength: [...EDIT_BUDGET.byLength], basis: EDIT_BUDGET.basis },
    initialWeight: INITIAL_WEIGHT,
    initialSimilarity: INITIAL_SIMILARITY,
  });
  const spellings: Spellings = { strings: new ObjectColumn() };
  const spellingByText = new StringMap<number>();
  const vocabulary = (form: Form): BuildingVocabulary => {
    const spellingIds = new NumberColumn();
    return {
      form,
      spellingIds,
      strings: new VocabularyStrings(spellings, spellingIds),
      characters: 0,
    };
  };
  const folded = vocabulary(FORM.folded);
  const raw = vocabulary(FORM.raw);
  const aliases = new AliasColumn({ folded: folded.strings, raw: raw.strings });
  const entryCounts = new NumberColumn();
  const tokenAliases = new NumberColumn();
  const joinAliases = new NumberColumn();
  const internFolded = (text: string) => {
    const id = intern({
      builder,
      vocabulary: folded,
      spellings,
      spellingIds: spellingByText,
      text,
    });
    growTo(entryCounts, folded.strings.length);
    growTo(tokenAliases, folded.strings.length);
    growTo(joinAliases, folded.strings.length);
    return id;
  };
  const internRaw = (text: string) =>
    intern({
      builder,
      vocabulary: raw,
      spellings,
      spellingIds: spellingByText,
      text,
    });

  for (const [entryIndex, entry] of entries.entries()) {
    const byKey = new Map<string, { alias: IndexedAlias; id: number }>();
    const entryTokens = new Set<number>();
    for (const { name, quality } of entry.names) {
      const { tokens, adjacent } = nameReading(name, entry.entityType);
      const key = `${tokens.map((token) => token.raw).join(" ")}|${adjacent.join(";")}`;
      const existing = byKey.get(key);
      if (tokens.length === 0 || existing?.alias.quality === "strong") {
        continue;
      }
      if (existing !== undefined) {
        // A weak alias the entry also lists as a strong one counts as strong.
        if (
          quality === "strong" ||
          (quality === "unknown" && existing.alias.quality === "weak")
        ) {
          existing.alias.quality = quality;
          aliases.setQuality(existing.id, quality);
        }
        continue;
      }
      const joined = (positions: readonly number[], form: keyof NameToken) =>
        positions.map((position) => tokens[position]?.[form] ?? "").join("");
      const alias: IndexedAlias = {
        entry: entryIndex,
        name,
        quality,
        entityType: entry.entityType,
        tokens,
        folded: tokens.map((token) => internFolded(token.folded)),
        raw: tokens.map((token) => internRaw(token.raw)),
        joins: adjacent.map((positions) => ({
          positions,
          folded: internFolded(joined(positions, "folded")),
          raw: internRaw(joined(positions, "raw")),
        })),
        patternKey: `${entry.entityType}|${key}`,
      };
      byKey.set(key, { alias, id: aliases.length });
      increment(tokenAliases, alias.folded);
      increment(
        joinAliases,
        alias.joins.map((join) => join.folded),
      );
      for (const id of alias.folded) {
        entryTokens.add(id);
      }
      aliases.push(alias);
    }
    increment(entryCounts, entryTokens);
    yield;
  }

  const maxWeight = Math.log(Math.max(entries.length, 1)) + 1;
  const weights = new NumberColumn("float");
  for (let id = 0; id < folded.strings.length; id += 1) {
    const count = entryCounts.get(id);
    weights.push(
      count === 0 ? maxWeight : Math.log(entries.length / count) + 1,
    );
    if (id % 4096 === 0) {
      yield;
    }
  }

  // A raw spelling can stand for more than one folded spelling; give its
  // vocabulary weight the largest, so it never understates a position.
  const foldedWeights = new Float64Array(folded.strings.length);
  const rawWeights = new Float64Array(raw.strings.length);
  for (let id = 0; id < folded.strings.length; id += 1) {
    foldedWeights[id] = weights.get(id);
  }
  const stats = {
    aliases: aliases.length,
    aliasUnits: 0,
    maxAliasTokens: 0,
    maxAliasUnits: 0,
  };
  const partial: Omit<NameIndex, "candidates" | "stats"> = {
    aliases,
    folded,
    raw,
    weights,
    tokenAliases,
    joinAliases,
    maxWeight,
  };
  for (let id = 0; id < aliases.length; id += 1) {
    const alias = aliases.get(id);
    const listed = aliasWeights(weights, alias);
    let minimumTotal = 0;
    for (const { minimumWeight } of listed) {
      minimumTotal += minimumWeight;
    }
    for (const [position, rawId] of alias.raw.entries()) {
      const foldedId = alias.folded[position] ?? panic("Missing folded token");
      rawWeights[rawId] = Math.max(
        rawWeights[rawId] ?? 0,
        weights.get(foldedId),
      );
    }
    for (const join of alias.joins) {
      rawWeights[join.raw] = Math.max(
        rawWeights[join.raw] ?? 0,
        weights.get(join.folded),
      );
    }
    builder.addAlias({
      entryId: alias.entry,
      entityGroup: alias.entry,
      quality: INDEX_QUALITY,
      forms: (["folded", "raw"] as const).map((form) => ({
        form: FORM[form],
        tokens: alias[form].map((tokenId, position) => ({
          id: tokenId,
          weight: listed[position]?.weight ?? panic("Missing listed weight"),
          minimumWeight:
            listed[position]?.minimumWeight ?? panic("Missing listed weight"),
        })),
        joins: alias.joins.map((join) => ({
          id: join[form],
          left: join.positions[0],
          right: join.positions[1],
        })),
        minimumTotal,
      })),
    });
    const units = alias.tokens.length + alias.joins.length;
    stats.aliasUnits += units;
    stats.maxAliasTokens = Math.max(stats.maxAliasTokens, alias.tokens.length);
    stats.maxAliasUnits = Math.max(stats.maxAliasUnits, units);
    if (id % ALIAS_STEP === 0) {
      yield;
    }
  }
  if (!(spellings.strings instanceof ObjectColumn)) {
    return panic("Spelling column was already packed");
  }
  spellings.strings = yield* spellingColumnSteps(spellings.strings);
  const complete = (candidates: EntityIndex): NameIndex => ({
    ...partial,
    candidates,
    stats: {
      ...stats,
      postings: candidates.postingCount,
      forms: [folded, raw],
    },
  });
  const weightsByForm = [foldedWeights, rawWeights];
  return {
    finish: () => complete(builder.finish(weightsByForm)),
    finishAsync: async () => complete(await builder.finishAsync(weightsByForm)),
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
  runSteps(nameIndexSteps(entries)).finish();

/** One query token, or two adjacent ones read as a single word. */
type QueryUnit = {
  /** As the reading pairs them; a repeated spelling may pair with itself. */
  positions: readonly number[];
  token: NameToken;
  /** Vocabulary ids within the edit budget, with 1 - edits / longer length. */
  folded: Map<number, number>;
  raw: Map<number, number>;
};

type PreparedQuery = {
  tokens: readonly NameToken[];
  weights: readonly number[];
  initials: readonly boolean[];
  units: readonly QueryUnit[];
};

const isInitial = (token: NameToken) => Array.from(token.raw).length === 1;

const searchCost = ({ cost }: EntitySearchResult) =>
  cost.lexiconCells +
  cost.lexiconMatches +
  cost.sortedAccesses +
  cost.randomAccessPairs +
  cost.survivors;

type SearchOptions = {
  index: NameIndex;
  query: EntityQuery;
  tau: number;
  work: ScreeningWorkBudget;
};
const searchCandidates = ({
  index,
  query,
  tau,
  work,
}: SearchOptions): EntitySearchResult | undefined => {
  if (work.exhausted) {
    return undefined;
  }
  const result = index.candidates.search(query, {
    tau,
    quality: INDEX_QUALITY,
    maxCost: work.remaining,
  });
  if (result.exhausted) {
    work.exhausted = true;
    return undefined;
  }
  return spendScreeningWork(work, searchCost(result)) ? result : undefined;
};

type MatchKey = { unit: number; form: number; id: number; similarity: number };
const matchKeys = function* ({
  matchKeys: keys,
  similarities,
}: EntitySearchResult): Generator<MatchKey, void, void> {
  for (let match = 0; match < similarities.length; match += 1) {
    yield {
      unit: keys[match * 3] ?? panic("Missing match unit"),
      form: keys[match * 3 + 1] ?? panic("Missing match form"),
      id: keys[match * 3 + 2] ?? panic("Missing match token"),
      similarity: similarities[match] ?? panic("Missing match similarity"),
    };
  }
};

type QueryWeightsOptions = {
  index: NameIndex;
  tokens: readonly NameToken[];
  initials: readonly boolean[];
  singles: readonly QueryUnit[];
  work: ScreeningWorkBudget;
};

/**
 * A query token weighs as its most similar listed folded token, preferring the
 * rarer spelling on ties; a token the list never uses weighs as the rarest.
 */
const queryWeights = ({
  index,
  tokens,
  initials,
  singles,
  work,
}: QueryWeightsOptions): number[] | undefined => {
  const lexicon = searchCandidates({
    index,
    query: {
      // A word needs a single unit in its token's form; initials play no
      // part in a lexicon-only search.
      tokens: tokens.map((token) => ({
        form: FORM.folded,
        text: token.folded,
        weight: index.maxWeight,
      })),
      units: singles.map(({ token, positions }) => ({
        form: FORM.folded,
        text: token.folded,
        positions: [...positions],
      })),
    },
    tau: LEXICON_ONLY_TAU,
    work,
  });
  if (lexicon === undefined) {
    return undefined;
  }
  const best = new Map<number, { id: number; similarity: number }>();
  const postings = (id: number) =>
    index.tokenAliases.get(id) + index.joinAliases.get(id);
  for (const { unit, id, similarity } of matchKeys(lexicon)) {
    if (index.tokenAliases.get(id) === 0) {
      continue;
    }
    const position =
      singles[unit]?.positions[0] ?? panic("Missing single query unit");
    const current = best.get(position);
    if (
      current === undefined ||
      similarity > current.similarity ||
      (similarity === current.similarity &&
        (postings(id) - postings(current.id) || id - current.id) < 0)
    ) {
      best.set(position, { id, similarity });
    }
  }
  return initials.map((initial, position) => {
    if (initial) {
      return INITIAL_WEIGHT;
    }
    const match = best.get(position);
    return match === undefined ? index.maxWeight : index.weights.get(match.id);
  });
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
  const singles: QueryUnit[] = [];
  for (const [position, token] of tokens.entries()) {
    if (!initials[position]) {
      singles.push({
        positions: [position],
        token,
        folded: new Map(),
        raw: new Map(),
      });
    }
  }
  const units = [...singles];
  for (const positions of adjacent) {
    if (positions.some((position) => initials[position])) {
      continue;
    }
    const joined = (form: keyof NameToken) =>
      positions.map((position) => tokens[position]?.[form] ?? "").join("");
    units.push({
      positions,
      token: { raw: joined("raw"), folded: joined("folded") },
      folded: new Map(),
      raw: new Map(),
    });
  }
  const weights = queryWeights({ index, tokens, initials, singles, work });
  if (weights === undefined) {
    return undefined;
  }
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

/** Share of the listed name's weight the alignment explains. */
const listedCoverage = (
  listed: readonly ListedWeight[],
  matched: ReadonlyMap<number, number>,
): number => {
  let alignedTotal = 0;
  let explained = 0;
  for (const [position, { weight, minimumWeight }] of listed.entries()) {
    const similarity = matched.get(position);
    alignedTotal += similarity === undefined ? minimumWeight : weight;
    if (similarity !== undefined) {
      explained += weight * similarity;
    }
  }
  return Math.min(1, explained / alignedTotal);
};

const queryCoverage = (
  weights: readonly number[],
  matched: ReadonlyMap<number, number>,
): number => {
  let totalWeight = 0;
  let explainedWeight = 0;
  for (const [position, weight] of weights.entries()) {
    totalWeight += weight;
    explainedWeight += weight * (matched.get(position) ?? 0);
  }
  return explainedWeight / totalWeight;
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
  const score = Math.sqrt(
    queryCoverage(query.weights, alignment.query) *
      listedCoverage(aliasWeights(index.weights, alias), alignment.listed),
  );
  return alias.quality === "weak" ? score * WEAK_ALIAS_FACTOR : score;
};

export type NameMatches = { matches: Map<number, NameMatch> };

export type NameMatch = { score: number; name: string };

const sortingWork = (count: number) => count * Math.ceil(Math.log2(count + 1));

const scoringPairs = (
  query: { tokens: number; units: number },
  alias: { tokens: number; joins: number },
) => query.units * (alias.tokens + alias.joins) + query.tokens * alias.tokens;

const scoringWork = (pairs: number, tokens: number) =>
  pairs * Math.max(1, Math.ceil(Math.log2(pairs + 1))) + tokens;

type MatchNamesOptions = {
  index: NameIndex;
  reading: NameReading;
  /** Name score below which no alias can reach the caller's cutoff. */
  tau: number;
  work: ScreeningWorkBudget;
};

/**
 * Best name score per entry index. The entity index returns every alias whose
 * candidate bound reaches `tau`; each distinct alias pattern is then scored
 * exactly. `undefined` means the work budget ran out: nothing is partial.
 */
export const matchNames = ({
  index,
  reading,
  tau,
  work,
}: MatchNamesOptions): NameMatches | undefined => {
  const query = prepareQuery({ index, reading, work });
  if (query === undefined) {
    return undefined;
  }
  const owners: QueryUnit[] = [];
  const units: EntityQuery["units"] = [];
  for (const unit of query.units) {
    const positions = [...new Set(unit.positions)];
    owners.push(unit, unit);
    units.push(
      { form: FORM.folded, text: unit.token.folded, positions },
      { form: FORM.raw, text: unit.token.raw, positions },
    );
  }
  const found = searchCandidates({
    index,
    query: {
      tokens: query.tokens.map((token, position) => ({
        form: FORM.raw,
        text: token.raw,
        weight: query.weights[position] ?? panic("Missing query weight"),
      })),
      units,
    },
    tau,
    work,
  });
  if (found === undefined) {
    return undefined;
  }
  for (const { unit, form, id, similarity } of matchKeys(found)) {
    const owner = owners[unit] ?? panic("Missing query unit");
    (form === FORM.folded ? owner.folded : owner.raw).set(id, similarity);
  }
  if (!spendScreeningWork(work, sortingWork(found.survivors.length))) {
    return undefined;
  }
  // Ascending alias ids keep ties on the entry's earliest listed name.
  const groups = new Map<string, number[]>();
  for (const aliasIndex of found.survivors.toSorted()) {
    if (!spendScreeningWork(work)) {
      return undefined;
    }
    const alias = index.aliases.metadata(aliasIndex);
    const key = `${alias.patternKey}|${alias.quality}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [aliasIndex]);
    } else {
      group.push(aliasIndex);
    }
  }
  const best = new Map<number, NameMatch>();
  for (const members of groups.values()) {
    const alias = index.aliases.get(members[0] ?? panic("Empty alias group"));
    const pairs = scoringPairs(
      { tokens: query.tokens.length, units: query.units.length },
      { tokens: alias.tokens.length, joins: alias.joins.length },
    );
    if (!spendScreeningWork(work, scoringWork(pairs, alias.tokens.length))) {
      return undefined;
    }
    const score = scoreAlias(index, alias, query);
    for (const aliasIndex of members) {
      if (!spendScreeningWork(work)) {
        return undefined;
      }
      const member = index.aliases.get(aliasIndex);
      const current = best.get(member.entry);
      if (score > 0 && (current === undefined || score > current.score)) {
        best.set(member.entry, { score, name: member.name });
      }
    }
  }
  return { matches: best };
};

type SearchWorkOptions = {
  stats: NameIndexStats;
  /** Per lookup unit, its spelling form and UTF-16 length. */
  units: readonly { form: Form; length: number }[];
  tokens: number;
};

// Every counter the entity index charges, at its worst: an edit-distance row
// per unit character and vocabulary character, every vocabulary spelling
// matched, every posting read once per unit or initial, every alias checked
// against every unit and initial, and every alias surviving.
const searchWorkBound = ({ stats, units, tokens }: SearchWorkOptions) => {
  let bound = 0;
  for (const { form, length } of units) {
    const vocabulary = stats.forms[form];
    bound +=
      (length + 1) * (vocabulary.characters + vocabulary.strings.length + 1) +
      vocabulary.strings.length;
  }
  const lists = units.length + tokens;
  return (
    bound +
    lists * stats.postings +
    lists * (2 * stats.aliasUnits + stats.aliases) +
    stats.aliases
  );
};

/**
 * Worst-case work {@link matchNames} spends on one reading, from the edition
 * and the validated input alone: it is never reached by a correct screening.
 */
export const nameWorkBound = (
  stats: NameIndexStats,
  { tokens, adjacent }: NameReading,
): number => {
  const singles = tokens.map((token) => ({
    folded: token.folded.length,
    raw: token.raw.length,
  }));
  const joined = adjacent.map((positions) => {
    let folded = 0;
    let raw = 0;
    for (const position of positions) {
      folded += tokens[position]?.folded.length ?? panic("Missing token");
      raw += tokens[position]?.raw.length ?? panic("Missing token");
    }
    return { folded, raw };
  });
  const forms = (lengths: readonly { folded: number; raw: number }[]) =>
    lengths.flatMap(({ folded, raw }) => [
      { form: FORM.folded, length: folded },
      { form: FORM.raw, length: raw },
    ]);
  const pairs = scoringPairs(
    { tokens: tokens.length, units: tokens.length + adjacent.length },
    {
      tokens: stats.maxAliasTokens,
      joins: stats.maxAliasUnits - stats.maxAliasTokens,
    },
  );
  return (
    tokens.length +
    adjacent.length +
    searchWorkBound({
      stats,
      units: singles.map(({ folded }) => ({
        form: FORM.folded,
        length: folded,
      })),
      tokens: tokens.length,
    }) +
    searchWorkBound({
      stats,
      units: forms([...singles, ...joined]),
      tokens: tokens.length,
    }) +
    sortingWork(stats.aliases) +
    stats.aliases * (2 + scoringWork(pairs, stats.maxAliasTokens))
  );
};
