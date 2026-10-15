import { panic } from "better-result";

import { distance } from "@stll/fuzzy-search";

import {
  type SpellingColumn,
  spellingColumnSteps,
  stringIdsSteps,
  NumberColumn,
  ObjectColumn,
  PostingColumn,
  StringMap,
} from "./compact-storage";
import { BuildingDeletions, deletionKey } from "./deletion-keys";
import type { AliasQuality, EntityType, SanctionsEntry } from "./entry";
import { nameReading } from "./normalise";
import type { NameToken, NameReading } from "./normalise";

// Defensive invariant: the edition/input-derived bound covers the full scan.
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
// A call, not a property read: callees spend the budget, so a narrowed
// `budget.exhausted` would go stale across them.
const screeningWorkExhausted = (budget: ScreeningWorkBudget): boolean =>
  budget.exhausted;

const SPELLING_CACHE_LIMIT = 16_384;
const NO_VOCABULARY_ID = -1;

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

/** Spellings are shared between the folded and raw vocabularies. */
type Spellings = {
  strings: ObjectColumn<string> | SpellingColumn;
};

class VocabularyStrings {
  // Direct-mapped slots avoid an LRU node allocation for every one-off
  // spelling when a query traverses more unique tokens than the cache holds.
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

type ReadonlyPostings = {
  get: (id: number) => Iterable<number>;
  size: (id: number) => number;
};

type Vocabulary = {
  strings: { readonly length: number; get: (id: number) => string };
  spellingIds: NumberColumn;
  spellings: Spellings;
  ids: Pick<StringMap<number>, "get">;
  lengths: Set<number>;
  deletes: { get: (key: number) => number | undefined };
  deletePostings: ReadonlyPostings;
  postings: ReadonlyPostings;
  joinPostings: ReadonlyPostings;
};

type BuildingVocabulary = Omit<
  Vocabulary,
  "ids" | "deletes" | "deletePostings" | "postings" | "joinPostings"
> & {
  ids: StringMap<number>;
  deletions: BuildingDeletions;
  postings: PostingColumn;
  joinPostings: PostingColumn;
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
      const foldedId = this.tokenIds.getUnchecked(offset);
      const rawId = this.tokenIds.getUnchecked(offset + 1);
      folded.push(foldedId);
      raw.push(rawId);
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
    const tokens = metadata.raw.map((rawId, position) => {
      const foldedId =
        metadata.folded[position] ?? panic("Missing folded token");
      const folded = this.folded.get(foldedId);
      return {
        folded,
        raw: this.raw === this.folded ? folded : this.raw.get(rawId),
      };
    });
    return { ...metadata, name: this.names.get(id), tokens };
  }
}

export type NameIndex = {
  aliases: AliasColumn;
  folded: Vocabulary;
  raw: Vocabulary;
  weights: NumberColumn;
  maxWeight: number;
};

const emptyVocabulary = (spellings: Spellings): BuildingVocabulary => {
  const spellingIds = new NumberColumn();
  return {
    strings: new VocabularyStrings(spellings, spellingIds),
    spellingIds,
    spellings,
    ids: new StringMap(),
    lengths: new Set(),
    deletions: new BuildingDeletions(),
    postings: new PostingColumn(),
    joinPostings: new PostingColumn(),
  };
};

/** Every distinct deletion through the budget, including the original string.
 * Deleting the affected characters on both sides of each edit (including a
 * transposition) leaves a common subsequence within that many deletions.
 */
export const deletionVariants = (text: string): Set<string> => {
  const variants = new Set([text]);
  let frontier = [text];
  for (let depth = 0; depth < editBudget(Array.from(text).length); depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      const characters = Array.from(current);
      for (let position = 0; position < characters.length; position += 1) {
        const variant = characters
          .filter((_, index) => index !== position)
          .join("");
        if (!variants.has(variant)) {
          variants.add(variant);
          next.push(variant);
        }
      }
    }
    frontier = next;
  }
  return variants;
};

type InternOptions = {
  vocabulary: BuildingVocabulary;
  text: string;
  spellingIds: StringMap<number>;
};
const intern = ({ vocabulary, text, spellingIds }: InternOptions): number => {
  const known = vocabulary.ids.get(text);
  if (known !== undefined) {
    return known;
  }
  const id = vocabulary.strings.length;
  const { spellings } = vocabulary;
  let spelling = spellingIds.get(text);
  if (spelling === undefined) {
    spelling = spellings.strings.push(text);
    spellingIds.set(text, spelling);
  }
  vocabulary.spellingIds.push(spelling);
  vocabulary.ids.set(text, id);
  vocabulary.lengths.add(Array.from(text).length);
  vocabulary.postings.addList();
  vocabulary.joinPostings.addList();
  for (const key of new Set(Array.from(deletionVariants(text), deletionKey))) {
    vocabulary.deletions.add(key, id);
  }
  return id;
};

const post = (lists: PostingColumn, ids: readonly number[], alias: number) => {
  for (const id of new Set(ids)) {
    lists.push(id, alias);
  }
};

function* compactVocabulary(
  vocabulary: BuildingVocabulary,
): Generator<void, Vocabulary, void> {
  const deletions = yield* vocabulary.deletions.compact();
  const { deletions: _buildingDeletions, ...columns } = vocabulary;
  return {
    ...columns,
    ids: yield* stringIdsSteps(vocabulary.strings),
    deletes: deletions.keys,
    deletePostings: deletions.postings,
    postings: yield* vocabulary.postings.compact(),
    joinPostings: yield* vocabulary.joinPostings.compact(),
  };
}

/**
 * Builds the name index one entry at a time, pausing after each so a caller
 * on a serving event loop can give way between entries; see
 * {@link buildNameIndex} for the uninterrupted build.
 * @yields Control between entries and fixed-size packing chunks.
 */
export function* nameIndexSteps(
  entries: Iterable<SanctionsEntry> & {
    readonly length: number;
    entries: () => Iterable<[number, SanctionsEntry]>;
  },
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
  const spellings: Spellings = {
    strings: new ObjectColumn(),
  };
  const spellingIds = new StringMap<number>();
  const folded = emptyVocabulary(spellings);
  const raw = canShareVocabularies ? folded : emptyVocabulary(spellings);
  const aliases = new AliasColumn({ folded: folded.strings, raw: raw.strings });
  const entryCounts = new NumberColumn();

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
      const alias: IndexedAlias = {
        entry: entryIndex,
        name,
        quality,
        entityType: entry.entityType,
        tokens,
        folded: tokens.map((token) =>
          intern({ vocabulary: folded, text: token.folded, spellingIds }),
        ),
        raw: tokens.map((token) =>
          intern({ vocabulary: raw, text: token.raw, spellingIds }),
        ),
        joins: adjacent.map((positions) => ({
          positions,
          folded: intern({
            vocabulary: folded,
            text: positions
              .map((position) => tokens[position]?.folded ?? "")
              .join(""),
            spellingIds,
          }),
          raw: intern({
            vocabulary: raw,
            text: positions
              .map((position) => tokens[position]?.raw ?? "")
              .join(""),
            spellingIds,
          }),
        })),
        patternKey: `${entry.entityType}|${key}`,
      };
      byKey.set(key, { alias, id: aliases.length });
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
      while (entryCounts.length <= id) {
        entryCounts.push(0);
      }
      entryCounts.set(id, entryCounts.get(id) + 1);
    }
    yield;
  }

  const maxWeight = Math.log(Math.max(entries.length, 1)) + 1;
  const weights = new NumberColumn("float");
  for (let id = 0; id < folded.strings.length; id += 1) {
    const count = id < entryCounts.length ? entryCounts.get(id) : 0;
    weights.push(
      count === 0 ? maxWeight : Math.log(entries.length / count) + 1,
    );
    if (id % 4096 === 0) {
      yield;
    }
  }
  if (!(spellings.strings instanceof ObjectColumn)) {
    panic("Spelling column was already packed");
  }
  spellings.strings = yield* spellingColumnSteps(spellings.strings);
  const compactFolded = yield* compactVocabulary(folded);
  const compactRaw =
    raw === folded ? compactFolded : yield* compactVocabulary(raw);
  return {
    aliases,
    folded: compactFolded,
    raw: compactRaw,
    weights,
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

/** Complete symmetric-deletion neighbourhood, followed by exact verification. */
type SimilarStringsOptions = {
  vocabulary: Vocabulary;
  text: string;
  work: ScreeningWorkBudget;
};
export const similarStrings = ({
  vocabulary,
  text,
  work,
}: SimilarStringsOptions): Map<number, number> => {
  const similar = new Map<number, number>();
  if (!spendScreeningWork(work, text.length + 1)) {
    return similar;
  }
  const length = Array.from(text).length;
  const exact = vocabulary.ids.get(text);
  if (exact !== undefined) {
    similar.set(exact, 1);
  }
  const budget = editBudget(length);
  // No edit can cross this length boundary. Avoid generating quadratic
  // deletion sets for long, valid input absent from the edition vocabulary.
  if (
    budget === 0 ||
    !Array.from(vocabulary.lengths).some(
      (other) =>
        Math.abs(length - other) <= editBudget(Math.min(length, other)),
    )
  ) {
    return similar;
  }
  const candidates = new Set<number>();
  for (const variant of deletionVariants(text)) {
    if (!spendScreeningWork(work, variant.length + 1)) {
      return similar;
    }
    const list = vocabulary.deletes.get(deletionKey(variant));
    if (list === undefined) {
      continue;
    }
    for (const id of vocabulary.deletePostings.get(list)) {
      if (!spendScreeningWork(work)) {
        return similar;
      }
      candidates.add(id);
    }
  }
  for (const id of candidates) {
    const candidate = vocabulary.strings.get(id);
    const candidateLength = Array.from(candidate).length;
    const pairBudget = editBudget(Math.min(length, candidateLength));
    if (Math.abs(length - candidateLength) > pairBudget) {
      continue;
    }
    if (
      !spendScreeningWork(work, Math.max(1, text.length * candidate.length))
    ) {
      return similar;
    }
    const edits = distance(text, candidate, METRIC);
    if (edits <= pairBudget) {
      similar.set(
        id,
        length === 0 ? 1 : 1 - edits / Math.max(length, candidateLength),
      );
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
      if (similarity > best && index.folded.postings.size(id) > 0) {
        best = similarity;
        weight = index.weights.get(id);
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
  alias: AliasMetadata;
  matched: ReadonlyMap<number, number>;
};
const listedCoverage = ({ index, alias, matched }: ListedCoverageOptions) => {
  let alignedTotal = 0;
  let minimumTotal = 0;
  let explained = 0;
  const last = alias.raw.length - 1;
  for (const [listed, rawId] of alias.raw.entries()) {
    const raw = index.raw.strings.get(rawId);
    const weight =
      raw.length === 1
        ? INITIAL_WEIGHT
        : index.weights.get(
            alias.folded[listed] ?? panic("Missing weighted token"),
          );
    const optional =
      alias.entityType === "person" &&
      ((listed > 0 && listed < last) ||
        PATRONYMIC.test(
          index.folded.strings.get(
            alias.folded[listed] ?? panic("Missing folded token"),
          ),
        ) ||
        PARTICLES.has(
          index.folded.strings.get(
            alias.folded[listed] ?? panic("Missing folded token"),
          ),
        ));
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
      listedCoverage({
        index,
        alias,
        matched: alignment.listed,
      }).aligned,
  );
  return alias.quality === "weak" ? score * WEAK_ALIAS_FACTOR : score;
};

type InitialCoverageOptions = {
  index: NameIndex;
  alias: AliasMetadata;
  query: PreparedQuery;
  queryMatched: Map<number, number>;
  listedMatched: Map<number, number>;
};

const accumulateInitialCoverage = ({
  index,
  alias,
  query,
  queryMatched,
  listedMatched,
}: InitialCoverageOptions): void => {
  const hasQueryInitials = query.initials.some(Boolean);
  for (const [listed, rawId] of alias.raw.entries()) {
    const listedRaw = index.raw.strings.get(rawId);
    const listedInitial = listedRaw.length === 1;
    if (!hasQueryInitials && !listedInitial) {
      continue;
    }
    for (const [position, token] of query.tokens.entries()) {
      const queryInitial = query.initials[position] === true;
      let similarity = 0;
      if (queryInitial && listedRaw.startsWith(token.raw)) {
        similarity = listedInitial ? 1 : INITIAL_SIMILARITY;
      } else if (
        !queryInitial &&
        listedInitial &&
        token.raw.startsWith(listedRaw)
      ) {
        similarity = INITIAL_SIMILARITY;
      }
      if (similarity > 0) {
        queryMatched.set(
          position,
          Math.max(queryMatched.get(position) ?? 0, similarity),
        );
        listedMatched.set(
          listed,
          Math.max(listedMatched.get(listed) ?? 0, similarity),
        );
      }
    }
  }
};

type CandidateEstimate = { bound: number; rank: number };
type CandidateEstimateOptions = {
  index: NameIndex;
  alias: AliasMetadata;
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
    for (let position = 0; position < alias.raw.length; position += 1) {
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
  const queryMatched = new Map<number, number>();
  const listedMatched = new Map<number, number>();
  let anchored = false;
  for (const queryUnit of query.units) {
    for (let listed = 0; listed < alias.raw.length; listed += 1) {
      const similarity = unitSimilarity(
        queryUnit,
        alias.folded[listed],
        alias.raw[listed],
      );
      if (similarity === 0) {
        continue;
      }
      anchored = true;
      for (const position of queryUnit.positions) {
        queryMatched.set(
          position,
          Math.max(queryMatched.get(position) ?? 0, similarity),
        );
      }
      listedMatched.set(
        listed,
        Math.max(listedMatched.get(listed) ?? 0, similarity),
      );
    }
    for (const join of alias.joins) {
      const similarity = unitSimilarity(queryUnit, join.folded, join.raw);
      if (similarity === 0) {
        continue;
      }
      anchored = true;
      for (const position of queryUnit.positions) {
        queryMatched.set(
          position,
          Math.max(queryMatched.get(position) ?? 0, similarity),
        );
      }
      for (const listed of join.positions) {
        listedMatched.set(
          listed,
          Math.max(listedMatched.get(listed) ?? 0, similarity),
        );
      }
    }
  }
  if (!anchored) {
    return { bound: 0, rank: 0 };
  }
  accumulateInitialCoverage({
    index,
    alias,
    query,
    queryMatched,
    listedMatched,
  });
  const queryShare = queryCoverage(query.weights, queryMatched);
  const coverage = listedCoverage({ index, alias, matched: listedMatched });
  return {
    bound: Math.sqrt(queryShare * coverage.minimum),
    rank: Math.sqrt(queryShare * coverage.aligned),
  };
};

export type NameMatches = {
  matches: Map<number, NameMatch>;
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
  // Vocabulary IDs are bijective with raw spellings; compare their multisets
  // without rebuilding and sorting decoded spelling strings for every alias.
  const exactKey = query.tokens
    .map((token) => index.raw.ids.get(token.raw) ?? NO_VOCABULARY_ID)
    .toSorted((left, right) => left - right)
    .join(",");
  for (const [aliasIndex, weight] of reachedWeight) {
    if (!spendScreeningWork(work)) {
      return undefined;
    }
    if (ceiling((weight + initialWeight) / totalWeight) < cutoff) {
      continue;
    }
    const alias = index.aliases.metadata(aliasIndex);
    const exact =
      alias.raw.length === query.tokens.length &&
      alias.raw.toSorted((left, right) => left - right).join(",") === exactKey;
    let estimate = exact
      ? { bound: 1, rank: 1 }
      : estimates.get(alias.patternKey);
    if (estimate === undefined) {
      const pairWork =
        query.units.length * (alias.raw.length + alias.joins.length) +
        query.tokens.length * alias.raw.length;
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
          for (const alias of vocabulary.postings.get(id)) {
            if (!spendScreeningWork(work)) {
              return undefined;
            }
            reached.add(alias);
          }
          for (const alias of vocabulary.joinPostings.get(id)) {
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
  for (const { aliasIndices, exact } of candidates) {
    const alias = index.aliases.get(aliasIndices[0]);
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
      const member = index.aliases.get(aliasIndex);
      const current = best.get(member.entry);
      if (score > 0 && (current === undefined || score > current.score)) {
        best.set(member.entry, { score, name: member.name });
      }
    }
  }
  return {
    matches: best,
  };
};
