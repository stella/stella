import { panic } from "better-result";

import {
  distance,
  type EntityIndex,
  EntityIndexBuilder,
  type EntitySearchResult,
} from "@stll/fuzzy-search";

import {
  NumberColumn,
  ObjectColumn,
  type SpellingColumn,
  spellingColumnSteps,
  stringIdsSteps,
  StringMap,
} from "./compact-storage";
import type { AliasQuality, EntityType, SanctionsEntry } from "./entry";
import { nameReadings, readingKey } from "./normalise";
import type { NameReading, NameToken } from "./normalise";

export type ScreeningWorkBudget = { remaining: number; exhausted: boolean };
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
const METRIC = "damerau-levenshtein";

// Weights are inverse document frequencies over entries, so a shared
// "Mohammed" counts for less than a shared rare surname.
const INITIAL_WEIGHT = 1;
const INITIAL_SIMILARITY = 0.8;
// A listed middle name, patronymic or particle the query omits costs a quarter
// of its weight; any other listed token the query omits costs all of it.
const MIDDLE_NAME_DISCOUNT = 0.25;
/** A weak alias, or a bracketed part read on its own, scores this share. */
export const WEAK_ALIAS_FACTOR = 0.9;
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

type Vocabulary = {
  strings: ObjectColumn<string> | SpellingColumn;
  ids: Pick<StringMap<number>, "get">;
};
type BuildingVocabulary = {
  strings: ObjectColumn<string>;
  ids: StringMap<number>;
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

  private folded;
  private raw;
  constructor({ folded, raw }: AliasColumnOptions) {
    this.folded = folded;
    this.raw = raw;
    this.tokenOffsets.push(0);
    this.joinOffsets.push(0);
  }

  setVocabularies(
    folded: Vocabulary["strings"],
    raw: Vocabulary["strings"],
  ): void {
    this.folded = folded;
    this.raw = raw;
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
  sharedVocabulary: boolean;
  wordIds: NumberColumn;
  entities: Pick<
    EntityIndex,
    "search" | "toBytes" | "nativeBytes" | "postingCount"
  >;
};
const intern = (vocabulary: BuildingVocabulary, text: string): number => {
  const known = vocabulary.ids.get(text);
  if (known !== undefined) {
    return known;
  }
  const id = vocabulary.strings.push(text);
  vocabulary.ids.set(text, id);
  return id;
};
const positionWeights = (
  index: Pick<NameIndex, "weights">,
  alias: IndexedAlias,
) =>
  alias.tokens.map((token, position) => {
    const id = alias.folded[position] ?? panic("Missing folded token");
    const weight =
      Array.from(token.raw).length === 1
        ? INITIAL_WEIGHT
        : index.weights.get(id);
    const optional =
      alias.entityType === "person" &&
      ((position > 0 && position < alias.tokens.length - 1) ||
        PATRONYMIC.test(token.folded) ||
        PARTICLES.has(token.folded));
    return {
      weight,
      minimumWeight: optional ? weight * MIDDLE_NAME_DISCOUNT : weight,
    };
  });

type EntityIndexBuildOptions = {
  aliases: AliasColumn;
  folded: BuildingVocabulary;
  raw: BuildingVocabulary;
  weights: NumberColumn;
};
export type IndexBuildSteps<T> = Generator<
  | {
      builder: EntityIndexBuilder;
      weights: Float64Array[];
      complete: (index: EntityIndex) => void;
    }
  | undefined,
  T,
  void
>;
function* entityIndexSteps({
  aliases,
  folded,
  raw,
  weights,
}: EntityIndexBuildOptions): IndexBuildSteps<EntityIndex> {
  const formCount = raw === folded ? 1 : 2;
  const builder = new EntityIndexBuilder({
    forms: formCount,
    budget: { byLength: [0, 0, 0, 0, 1, 1, 2], basis: "shorter" },
    initialWeight: INITIAL_WEIGHT,
    initialSimilarity: INITIAL_SIMILARITY,
  });
  for (const [form, vocabulary] of [folded, raw]
    .slice(0, formCount)
    .entries()) {
    for (let id = 0; id < vocabulary.strings.length; id += 1) {
      const text = vocabulary.strings.get(id);
      if (builder.intern(form, text) !== id) {
        panic("Entity vocabulary ids diverged");
      }
      if (id % 4096 === 0) {
        yield;
      }
    }
  }
  const rawWeights = new Float64Array(raw.strings.length);
  for (let id = 0; id < aliases.length; id += 1) {
    const alias = aliases.get(id);
    for (const [position, rawId] of alias.raw.entries()) {
      rawWeights[rawId] = weights.get(
        alias.folded[position] ?? panic("Missing folded weight"),
      );
    }
    for (const join of alias.joins) {
      rawWeights[join.raw] = weights.get(join.folded);
    }
    const positions = positionWeights({ weights }, alias);
    builder.addAlias({
      entryId: alias.entry,
      entityGroup: alias.entityType === "person" ? 0 : 1,
      // Quality stays in final scoring; lowering this bound could lose candidates.
      quality: 1,
      forms: [alias.folded, alias.raw].slice(0, formCount).map((ids, form) => ({
        form,
        tokens: ids.map((token, position) => ({
          id: token,
          ...(positions[position] ?? panic("Missing position weights")),
        })),
        joins: alias.joins.map((join) => ({
          id: form === 0 ? join.folded : join.raw,
          left: join.positions[0],
          right: join.positions[1],
        })),
        minimumTotal: positions.reduce(
          (total, position) => total + position.minimumWeight,
          0,
        ),
      })),
    });
    yield;
  }
  const foldedWeights = Float64Array.from(
    { length: folded.strings.length },
    (_, id) => weights.get(id),
  );
  // Native construction units can prepare an entire vocabulary or finalize
  // all postings; the cooperative driver must run that work off-thread.
  let entities: EntityIndex | undefined;
  yield {
    builder,
    weights: [foldedWeights, rawWeights].slice(0, formCount),
    complete: (index) => {
      entities = index;
    },
  };
  return entities ?? panic("Entity index construction did not return an index");
}

export function* nameIndexSteps(
  entries: Iterable<SanctionsEntry> & {
    readonly length: number;
    entries: () => Iterable<[number, SanctionsEntry]>;
  },
): IndexBuildSteps<NameIndex> {
  let share = true;
  for (const entry of entries) {
    if (
      entry.names.some(({ name }) =>
        nameReadings(name, entry.entityType).some(({ reading }) =>
          reading.tokens.some(({ raw, folded }) => raw !== folded),
        ),
      )
    ) {
      share = false;
      break;
    }
    yield;
  }
  const folded: BuildingVocabulary = {
    strings: new ObjectColumn(),
    ids: new StringMap(),
  };
  const raw = share
    ? folded
    : { strings: new ObjectColumn<string>(), ids: new StringMap<number>() };
  const aliases = new AliasColumn({ folded: folded.strings, raw: raw.strings });
  const counts = new Map<number, number>();
  for (const [entryIndex, entry] of entries.entries()) {
    const byKey = new Map<string, { alias: IndexedAlias; id: number }>();
    const entryTokens = new Set<number>();
    // Every variant of a listed name indexes under the listed name itself, so
    // a match on the name without its brackets shows what was listed. Only
    // the listed name's own reading, which comes first, counts towards token
    // frequencies: a derived variant never changes another entry's weights.
    const variants = entry.names.flatMap(({ name, quality }) =>
      nameReadings(name, entry.entityType).map(
        ({ reading, qualifier }, position) => ({
          name,
          reading,
          quality: qualifier ? ("weak" as const) : quality,
          listed: position === 0,
        }),
      ),
    );
    for (const { name, reading, quality, listed } of variants) {
      const { tokens, adjacent } = reading;
      if (listed) {
        for (const token of tokens) {
          entryTokens.add(intern(folded, token.folded));
        }
      }
      const key = readingKey(reading);
      const existing = byKey.get(key);
      if (tokens.length === 0 || existing?.alias.quality === "strong") {
        continue;
      }
      if (existing !== undefined) {
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
      };
      byKey.set(key, { alias, id: aliases.length });
      aliases.push(alias);
    }
    for (const id of entryTokens) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    yield;
  }
  const maxWeight = Math.log(Math.max(entries.length, 1)) + 1;
  const weights = new NumberColumn("float");
  const wordIds = new NumberColumn("byte");
  for (let id = 0; id < folded.strings.length; id += 1) {
    const count = counts.get(id) ?? 0;
    wordIds.push(count > 0 ? 1 : 0);
    weights.push(
      count === 0 ? maxWeight : Math.log(entries.length / count) + 1,
    );
    if (id % 4096 === 0) {
      yield;
    }
  }
  const entities = yield* entityIndexSteps({ aliases, folded, raw, weights });
  const foldedStrings = yield* spellingColumnSteps(folded.strings);
  const compactFolded = {
    strings: foldedStrings,
    ids: yield* stringIdsSteps(foldedStrings),
  };
  const rawStrings =
    raw === folded ? foldedStrings : yield* spellingColumnSteps(raw.strings);
  const compactRaw =
    raw === folded
      ? compactFolded
      : { strings: rawStrings, ids: yield* stringIdsSteps(rawStrings) };
  // AliasColumn owns the build spellings; keep its decoding source compact too.
  aliases.setVocabularies(compactFolded.strings, compactRaw.strings);
  return {
    aliases,
    folded: compactFolded,
    raw: compactRaw,
    weights,
    maxWeight,
    sharedVocabulary: raw === folded,
    wordIds,
    entities,
  };
}
export const runSteps = <T>(steps: IndexBuildSteps<T>): T => {
  for (;;) {
    const step = steps.next();
    if (step.done === true) {
      return step.value;
    }
    if (step.value !== undefined) {
      step.value.complete(step.value.builder.finish(step.value.weights));
    }
  }
};
export const buildNameIndex = (entries: readonly SanctionsEntry[]): NameIndex =>
  runSteps(nameIndexSteps(entries));

type QueryUnit = {
  positions: readonly number[];
  folded: Map<number, number>;
  raw: Map<number, number>;
};
type PreparedQuery = {
  tokens: readonly NameToken[];
  weights: readonly number[];
  initials: readonly boolean[];
  units: readonly QueryUnit[];
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
    const similarity = matched.get(listed);
    alignedTotal += similarity === undefined ? minimumWeight : weight;
    if (similarity !== undefined) {
      explained += weight * similarity;
    }
  }
  return {
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

export type NameMatches = {
  matches: Map<number, NameMatch>;
  truncated: boolean;
};
export type NameMatch = { score: number; name: string };
type MatchNamesOptions = {
  index: NameIndex;
  reading: NameReading;
  ceiling: (queryShare: number) => number;
  cutoff: number;
  work: ScreeningWorkBudget;
};
type QuerySource = {
  type: "token" | "join";
  positions: readonly number[];
  token: NameToken;
};
type PopulateQueryUnitsOptions = {
  index: NameIndex;
  sources: readonly QuerySource[];
  result: EntitySearchResult;
  work: ScreeningWorkBudget;
};
const populateQueryUnits = ({
  index,
  sources,
  result,
  work,
}: PopulateQueryUnitsOptions): QueryUnit[] | undefined => {
  const units: QueryUnit[] = sources.map(({ positions }) => ({
    positions,
    folded: new Map(),
    raw: new Map(),
  }));
  for (let hit = 0; hit < result.similarities.length; hit += 1) {
    const unitId = result.matchKeys[hit * 3] ?? panic("Missing match unit");
    const form = result.matchKeys[hit * 3 + 1] ?? panic("Missing match form");
    const id = result.matchKeys[hit * 3 + 2] ?? panic("Missing match token");
    const sourceId = index.sharedVocabulary ? unitId : Math.floor(unitId / 2);
    const unit = units[sourceId] ?? panic("Invalid match unit");
    const source = sources[sourceId] ?? panic("Missing query source");
    const vocabulary = form === 0 ? index.folded : index.raw;
    const text = form === 0 ? source.token.folded : source.token.raw;
    const listed = vocabulary.strings.get(id);
    if (
      !spendScreeningWork(
        work,
        Math.max(1, Array.from(text).length * Array.from(listed).length),
      )
    ) {
      return undefined;
    }
    // Retain the sanctions metric as the verification and scoring authority.
    const edits = distance(text, listed, METRIC);
    const shorter = Math.min(
      Array.from(text).length,
      Array.from(listed).length,
    );
    let budget = 2;
    if (shorter <= 3) {
      budget = 0;
    } else if (shorter <= 5) {
      budget = 1;
    }
    if (edits > budget) {
      continue;
    }
    const similarity =
      result.similarities[hit] ?? panic("Missing token similarity");
    const verified =
      1 - edits / Math.max(Array.from(text).length, Array.from(listed).length);
    if (Math.abs(similarity - verified) > Number.EPSILON) {
      panic("Entity token similarity disagrees with the sanctions metric");
    }
    (form === 0 ? unit.folded : unit.raw).set(id, similarity);
  }
  return units;
};

export const matchNames = ({
  index,
  reading,
  ceiling,
  cutoff,
  work,
}: MatchNamesOptions): NameMatches | undefined => {
  const initials = reading.tokens.map(
    (token) => Array.from(token.raw).length === 1,
  );
  const tokenSources = reading.tokens.flatMap((token, position) =>
    initials[position]
      ? []
      : [{ type: "token" as const, positions: [position], token }],
  );
  // Every joined query spelling is searched: even when each part is a listed
  // word, the join can fuzzily match a different listed single word.
  const joinedSources = reading.adjacent
    .filter((positions) => !positions.some((position) => initials[position]))
    .map((positions) => ({
      type: "join" as const,
      positions,
      token: {
        raw: positions
          .map((position) => reading.tokens[position]?.raw ?? "")
          .join(""),
        folded: positions
          .map((position) => reading.tokens[position]?.folded ?? "")
          .join(""),
      },
    }));
  const sources = [...tokenSources, ...joinedSources];
  // ceiling(s) = a + (1-a)*sqrt(s); EntityIndex bounds the name score.
  const a = ceiling(0);
  const threshold = a === 1 ? 0 : Math.max(0, (cutoff - a) / (1 - a));
  const queryWeights = reading.tokens.map((token, position) => {
    if (initials[position]) {
      return INITIAL_WEIGHT;
    }
    const id = index.folded.ids.get(token.folded);
    return id === undefined || index.wordIds.get(id) === 0
      ? index.maxWeight
      : index.weights.get(id);
  });
  const lookupQuery = {
    tokens: reading.tokens.map((token, position) => ({
      form: initials[position] && !index.sharedVocabulary ? 1 : 0,
      text: initials[position] ? token.raw : token.folded,
      weight: queryWeights[position] ?? panic("Missing query weight"),
    })),
    units: sources.flatMap(({ positions, token }) => {
      const uniquePositions = [...new Set(positions)];
      const folded = {
        form: 0,
        text: token.folded,
        positions: uniquePositions,
      };
      return index.sharedVocabulary
        ? [folded]
        : [folded, { form: 1, text: token.raw, positions: uniquePositions }];
    }),
  };
  const needsWeights = reading.tokens.some((token, position) => {
    if (initials[position]) {
      return false;
    }
    const id = index.folded.ids.get(token.folded);
    return id === undefined || index.wordIds.get(id) === 0;
  });
  const search = (tau: number) => {
    const query = {
      ...lookupQuery,
      tokens: lookupQuery.tokens.map((token, position) => ({
        ...token,
        weight: queryWeights[position] ?? panic("Missing selected weight"),
      })),
    };
    return index.entities.search(query, {
      tau,
      quality: 1,
      maxCost: work.remaining,
    });
  };
  // Unknown words select IDF from all equally close folded word spellings,
  // in caller intern order. A tau=0 lookup cannot prune that weight source.
  let result = search(
    needsWeights ? 0 : Math.max(0, threshold - Number.EPSILON * 8),
  );
  const chargeSearch = () => {
    const cost = Object.values(result.cost).reduce(
      (total, value) => total + value,
      0,
    );
    // The native index reports the exact work performed, including a shared
    // vocabulary's single search, so charge that cost without a multiplier.
    if (!spendScreeningWork(work, cost) || result.exhausted) {
      work.exhausted = true;
      return false;
    }
    return true;
  };
  if (!chargeSearch()) {
    return undefined;
  }
  const units = populateQueryUnits({ index, sources, result, work });
  if (units === undefined) {
    return undefined;
  }
  if (needsWeights) {
    for (const [unitId, source] of sources.entries()) {
      if (source.type !== "token") {
        continue;
      }
      const position =
        source.positions.at(0) ?? panic("Missing single position");
      const unit = units[unitId] ?? panic("Missing query unit");
      let best = -1;
      let bestId = Number.MAX_SAFE_INTEGER;
      for (const [id, similarity] of unit.folded) {
        if (index.wordIds.get(id) === 0) {
          continue;
        }
        if (similarity > best || (similarity === best && id < bestId)) {
          best = similarity;
          bestId = id;
          queryWeights[position] = index.weights.get(id);
        }
      }
    }
    result = search(Math.max(0, threshold - Number.EPSILON * 8));
    if (!chargeSearch()) {
      return undefined;
    }
  }
  const query: PreparedQuery = {
    tokens: reading.tokens,
    initials,
    weights: queryWeights,
    units,
  };
  const best = new Map<number, NameMatch>();
  const scores = new Map<string, number>();
  for (const id of result.survivors) {
    const alias = index.aliases.get(id);
    const key = `${alias.patternKey}|${alias.quality}`;
    let score = scores.get(key);
    if (score === undefined) {
      const pairs =
        units.length * (alias.tokens.length + alias.joins.length) +
        reading.tokens.length * alias.tokens.length;
      if (
        !spendScreeningWork(
          work,
          pairs * Math.max(1, Math.ceil(Math.log2(pairs + 1))) +
            alias.tokens.length +
            1,
        )
      ) {
        return undefined;
      }
      score = scoreAlias(index, alias, query);
      scores.set(key, score);
    }
    if (!spendScreeningWork(work)) {
      return undefined;
    }
    const current = best.get(alias.entry);
    if (score > 0 && (current === undefined || score > current.score)) {
      best.set(alias.entry, { score, name: alias.name });
    }
  }
  return { matches: best, truncated: false };
};
