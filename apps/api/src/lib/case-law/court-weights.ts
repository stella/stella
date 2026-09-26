/**
 * Court weight loader with in-memory cache: the seeded per-jurisdiction rank
 * table, compiled once a minute. The cache is per source; the public corpus
 * and the local one each own an instance (`public-case-law-config.ts`,
 * `local-case-law-config.ts`).
 */
import { panic } from "better-result";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import { Temporal } from "@stll/time";

import { arrayOrEmpty } from "@/api/lib/array";
import type { CourtWeightRow } from "@/api/lib/case-law/case-law-config-read";
import { usCourtRank } from "@/api/lib/case-law/court-ranks";
import { courtTierLabel } from "@/api/lib/case-law/court-tiers";
import { LOWEST_COURT_TIER } from "@/api/lib/legal-search/rerank";
import { logger } from "@/api/lib/observability/logger";
import { SQL_NULL, sqlCaseExpression } from "@/api/lib/sql-case-expression";
import { withTimeout } from "@/api/lib/with-timeout";

// -- Types ---------------------------------------------------------------

export type CourtWeightEntry = {
  /** The jurisdiction that ranks this court; part of the precedence order. */
  country: string;
  pattern: RegExp;
  tier: number;
  tierLabel: string;
  weight: number;
};

/** Country code → compiled weight entries. */
export type CourtWeightMap = Map<string, CourtWeightEntry[]>;

/**
 * Code-unit order over a country code or a pattern source. Deliberately not a
 * collator: these are identifiers, and a locale-sensitive comparison would
 * make a decision's rank depend on the reader's language, which is the drift
 * this order exists to remove. It also matches Postgres's `ORDER BY` under
 * the C collation the ASCII country codes and patterns fall back to.
 */
const compareCode = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * The order every lookup resolves in: highest rank first, then the country
 * code, then the pattern. `(country, pattern)` is unique in the table, so the
 * order is total — two registries holding the same rows resolve an overlapping
 * pattern the same way whatever order the rows arrived in.
 *
 * That totality is the point. A court name can match patterns from more than
 * one jurisdiction, so without a tie-break the tier a decision got would
 * depend on row order, and a cache refresh could silently re-rank it. Applied
 * to every list a lookup walks, it makes the read's own order irrelevant,
 * which is why `readCourtWeightRowsQuery` does not sort.
 */
export const compareCourtWeightPrecedence = (
  a: CourtWeightEntry,
  b: CourtWeightEntry,
): number =>
  b.tier - a.tier ||
  compareCode(a.country, b.country) ||
  compareCode(a.pattern.source, b.pattern.source);

// -- Cache ---------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

type CourtWeightRows = readonly CourtWeightRow[];

export type LoadCourtWeightsOptions = {
  /**
   * Performs the registry read, given the production one to wrap. Called only
   * when the cache misses, so a caller that times its Postgres work records
   * the query it actually made rather than one per request for a table it
   * read minutes ago. A test supplies rows of its own and never calls it.
   */
  onRead?: (read: () => Promise<CourtWeightRows>) => Promise<CourtWeightRows>;
};

const untimedRead = async (
  read: () => Promise<CourtWeightRows>,
): Promise<CourtWeightRows> => await read();

/**
 * The registry is a few dozen rows, so a read this slow is a degraded
 * database rather than a big answer. A pooled connection the server reaped
 * without an RST never settles the query promise, and a search request
 * awaiting it would hang rather than fail. Bounded, the request fails while
 * the 60 s cache keeps a healthy database to at most one read a minute.
 */
const READ_TIMEOUT_MS = 5000;

const boundedRead = async (
  read: () => Promise<CourtWeightRows>,
): Promise<CourtWeightRows> =>
  await withTimeout(read, {
    label: "court-weight-registry-read",
    timeoutMs: READ_TIMEOUT_MS,
  });

const compileCourtWeightRows = (rows: CourtWeightRows): CourtWeightMap => {
  if (rows.length === 0) {
    // The seed migration inserts the rows, so an empty table is a database
    // that was not migrated. Every court then weighs the default; this line
    // is what makes that visible.
    logger.warn("case_law.court_weights.table_empty", {
      effect: "default_weight_for_every_court",
    });
  }

  const map: CourtWeightMap = new Map();
  for (const row of rows) {
    const storedEntries = map.get(row.country);
    const entries = arrayOrEmpty(storedEntries);
    entries.push({
      country: row.country,
      pattern: new RegExp(row.courtPattern, "iu"),
      tier: row.tier,
      tierLabel: row.tierLabel,
      weight: row.weight,
    });
    map.set(row.country, entries);
  }

  for (const entries of map.values()) {
    entries.sort(compareCourtWeightPrecedence);
  }
  return map;
};

type CourtWeightRead = () => Promise<CourtWeightRows>;

/** One source's registry, compiled and cached for 60 s. */
export type CourtWeightCache = {
  /** The registry, read through the source's own connection on a miss. */
  load: (options?: LoadCourtWeightsOptions) => Promise<CourtWeightMap>;
  /**
   * The registry for a caller that already holds a connection to the source:
   * a miss runs `read` on it rather than asking the source's pool for a
   * second one. A caller holding a transaction on a small pool must use this;
   * waiting for another connection there can wait on itself.
   */
  loadWithin: (
    read: CourtWeightRead,
    options?: LoadCourtWeightsOptions,
  ) => Promise<CourtWeightMap>;
  /** One country's entries, in the order `load` guarantees. */
  loadForCountry: (country: string) => Promise<CourtWeightEntry[]>;
  /** Drop the cached registry (e.g. after seeding). */
  invalidate: () => void;
};

/**
 * A registry cache over one source's rows. The source decides which database
 * the registry comes from; the cache keeps it to one read a minute and never
 * answers from another source's rows.
 *
 * Concurrent misses share one read. A caller holding no connection may wait
 * on any read in flight. A caller holding one waits only on a read that
 * already has its connection (another holder's), never on one still queued
 * for the pool.
 */
export const createCourtWeightCache = (
  readRows: CourtWeightRead,
): CourtWeightCache => {
  let cached: { map: CourtWeightMap; expiresAt: number } | null = null;
  let pending: {
    promise: Promise<CourtWeightMap>;
    holdsConnection: boolean;
    token: symbol;
  } | null = null;

  const fresh = (): CourtWeightMap | null =>
    cached && Temporal.Now.instant().epochMilliseconds < cached.expiresAt
      ? cached.map
      : null;

  const readAndCache = async (
    read: CourtWeightRead,
    onRead: NonNullable<LoadCourtWeightsOptions["onRead"]>,
  ): Promise<CourtWeightMap> => {
    const map = compileCourtWeightRows(
      await onRead(async () => await boundedRead(read)),
    );
    cached = {
      map,
      expiresAt: Temporal.Now.instant().epochMilliseconds + CACHE_TTL_MS,
    };
    return map;
  };

  const startRead = async (
    read: CourtWeightRead,
    onRead: NonNullable<LoadCourtWeightsOptions["onRead"]>,
    holdsConnection: boolean,
  ): Promise<CourtWeightMap> => {
    const token = Symbol("court-weight-read");
    const promise = readAndCache(read, onRead).finally(() => {
      if (pending?.token === token) {
        pending = null;
      }
    });
    pending = { promise, holdsConnection, token };
    return await promise;
  };

  const load = async ({
    onRead = untimedRead,
  }: LoadCourtWeightsOptions = {}): Promise<CourtWeightMap> =>
    fresh() ?? (await (pending?.promise ?? startRead(readRows, onRead, false)));

  const loadWithin = async (
    read: CourtWeightRead,
    { onRead = untimedRead }: LoadCourtWeightsOptions = {},
  ): Promise<CourtWeightMap> =>
    fresh() ??
    (await (pending?.holdsConnection === true
      ? pending.promise
      : startRead(read, onRead, true)));

  return {
    load,
    loadWithin,
    loadForCountry: async (country) =>
      arrayOrEmpty((await load()).get(country)),
    invalidate: () => {
      cached = null;
      pending = null;
    },
  };
};

// -- Lookup --------------------------------------------------------------

const DEFAULT_WEIGHT = 1;
/** The rank a court nobody ranked carries: the bottom of the pinned scale. */
const DEFAULT_TIER = LOWEST_COURT_TIER;

/**
 * Rank a court name: its own jurisdiction's patterns first, then every
 * jurisdiction's in precedence order, then the default for a court nobody
 * ranks. Both passes walk lists `compareCourtWeightPrecedence` ordered, so the
 * first match is a property of the registry's contents and not of the order
 * its rows arrived in.
 */
export const courtWeightFromMap = (
  map: CourtWeightMap,
  court: string,
  country?: string,
): { weight: number; tier: number } => {
  const firstMatch = (
    entries: readonly CourtWeightEntry[],
  ): CourtWeightEntry | undefined =>
    entries.find((entry) => entry.pattern.test(court));

  // The cross-jurisdiction pass is flat, not country-by-country: a nested walk
  // takes whichever country the map happens to hold first, which is a row
  // order, not a rank.
  const matched =
    (country === undefined
      ? undefined
      : firstMatch(arrayOrEmpty(map.get(country)))) ??
    firstMatch(flattenCourtWeightEntries(map));

  return matched === undefined
    ? { weight: DEFAULT_WEIGHT, tier: DEFAULT_TIER }
    : { weight: matched.weight, tier: matched.tier };
};

type DecisionCourt = {
  court: string;
  country: string;
  /** The directory court id, where the decision's jurisdiction stores one. */
  courtId: string | null;
};

/**
 * Rank a decision's court. A decision that stores a directory court id is
 * ranked by that court's directory tier, since the id and not the name is its
 * identity; every other decision is ranked by name through the registry,
 * exactly as `courtWeightFromMap` ranks it. A stored id the directory does not
 * accept was never admitted by the write boundary, so it fails rather than
 * falling back to the default rank.
 */
export const decisionCourtWeight = (
  map: CourtWeightMap,
  { court, country, courtId }: DecisionCourt,
): { weight: number; tier: number } => {
  if (courtId === null) {
    return courtWeightFromMap(map, court, country);
  }
  const rank =
    usCourtRank(courtId) ?? panic(`Unranked directory court id: ${courtId}`);
  return { weight: rank.weight, tier: rank.tier };
};

/**
 * The tier a court name is presented under: the registry's own precedence
 * rules, then the bucket every unranked court falls into.
 */
export const courtTierLabelFromMap = (
  map: CourtWeightMap,
  court: string,
  country?: string,
): CourtTierLabel =>
  courtTierLabel(courtWeightFromMap(map, court, country).tier);

/** A single-quoted SQL literal; the registry is operator-seeded, not input. */
const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

type CourtTierSqlOptions = {
  /** SQL reference to the court-name column. A code constant, never input. */
  courtColumn: string;
  /** SQL reference to the country column. A code constant, never input. */
  countryColumn: string;
  map: CourtWeightMap;
};

/**
 * `courtWeightFromMap`'s tier lookup rendered as SQL, branch for branch: the
 * decision's own country first, then every jurisdiction's patterns, then the
 * default tier. A CASE whose ELSE is NULL evaluates to NULL when nothing
 * matches, which is what makes COALESCE the fallback chain the TypeScript
 * walks with `return`. An unseeded registry renders no branches at all, and
 * both CASEs collapse to that NULL, leaving the default tier.
 *
 * Both CASEs are emitted from the same precedence-ordered list the TypeScript
 * walks, because a CASE takes its first true branch just as the lookup takes
 * its first match: render them in a different order and the two runtimes rank
 * the same court differently.
 *
 * The Postgres ranking paths score inside the statement, because the keyset
 * cursor predicate has to be the same expression as the ORDER BY. So the
 * court-tier prior exists in both runtimes, and `authority-sql.test.ts` runs
 * the two over the same fixtures and holds them equal.
 */
export const courtTierSqlFromMap = ({
  courtColumn,
  countryColumn,
  map,
}: CourtTierSqlOptions): string => {
  const ordered = flattenCourtWeightEntries(map);
  const scoped = ordered.map(
    (entry) =>
      `WHEN ${countryColumn} = ${sqlLiteral(entry.country)} AND ${courtColumn} ~* ${sqlLiteral(entry.pattern.source)} THEN ${entry.tier}`,
  );
  const anyCountry = ordered.map(
    (entry) =>
      `WHEN ${courtColumn} ~* ${sqlLiteral(entry.pattern.source)} THEN ${entry.tier}`,
  );

  return `COALESCE(
      ${sqlCaseExpression({ branches: scoped, fallback: SQL_NULL })},
      ${sqlCaseExpression({ branches: anyCountry, fallback: SQL_NULL })},
      ${DEFAULT_TIER}
    )`;
};

// -- SQL entries -----------------------------------------------------------

/**
 * Per-map-instance cache of the flattened, sorted entries. A court-weight
 * cache only ever replaces its map by swapping in a brand-new `Map` on refresh
 * (never mutating an existing instance in place), so keying on the map
 * instance gives free invalidation: once the 60 s TTL rotates in a new map,
 * this WeakMap simply misses and recomputes, and the old entry is GC'd along
 * with its map.
 */
const flattenedEntriesCache = new WeakMap<CourtWeightMap, CourtWeightEntry[]>();

/**
 * Every country's entries as one list in `compareCourtWeightPrecedence`
 * order. This is the registry's cross-jurisdiction ranking, and the only one:
 * the lookup's fallback pass, the tier CASE, and the citing-court CASE all
 * read it, so no caller can invent an order of its own.
 *
 * Cross-jurisdiction because citation graphs cross borders — the citing court
 * in `citation-authority.ts` and `decisions/search.ts` can belong to any
 * seeded country. An empty map flattens to an empty list, which renders as
 * the default weight for every court.
 */
export const flattenCourtWeightEntries = (
  map: CourtWeightMap,
): CourtWeightEntry[] => {
  const flattened = flattenedEntriesCache.get(map);
  if (flattened !== undefined) {
    return flattened;
  }

  const entries = [...map.values()]
    .flat()
    .toSorted(compareCourtWeightPrecedence);
  flattenedEntriesCache.set(map, entries);
  return entries;
};
