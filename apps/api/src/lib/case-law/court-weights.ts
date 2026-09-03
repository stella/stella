/**
 * Court weight loader with in-memory cache: the seeded per-jurisdiction rank
 * table, compiled once a minute.
 */

import { arrayOrEmpty } from "@/api/lib/array";
import { readCourtWeightRows } from "@/api/lib/case-law/case-law-config-store";
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
 * which is why `readCourtWeightRows` does not sort.
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

let cached: { map: CourtWeightMap; expiresAt: number } | null = null;

type CourtWeightRows = Awaited<ReturnType<typeof readCourtWeightRows>>;

type LoadCourtWeightsOptions = {
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
 * database rather than a big answer. It runs on the root pool, where a
 * connection the server reaped without an RST never settles the query
 * promise, and a search request awaiting it would hang rather than fail.
 * Bounded, the request fails while the 60 s cache keeps a healthy database
 * to at most one read a minute.
 */
const READ_TIMEOUT_MS = 5000;

const boundedRead = async (
  read: () => Promise<CourtWeightRows>,
): Promise<CourtWeightRows> =>
  await withTimeout(read, {
    label: "court-weight-registry-read",
    timeoutMs: READ_TIMEOUT_MS,
  });

/** Load court weights from the database, caching for 60 s. */
export const loadCourtWeights = async ({
  onRead = untimedRead,
}: LoadCourtWeightsOptions = {}): Promise<CourtWeightMap> => {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.map;
  }

  const rows = await onRead(async () => await boundedRead(readCourtWeightRows));

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

  cached = { map, expiresAt: Date.now() + CACHE_TTL_MS };
  return map;
};

/** Invalidate the cache (e.g. after seeding). */
export const invalidateCourtWeightsCache = (): void => {
  cached = null;
};

// -- Lookup --------------------------------------------------------------

const DEFAULT_WEIGHT = 1;
const DEFAULT_TIER = 1;

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

/**
 * Load weights for a single country.
 */
export const loadCourtWeightsForCountry = async (
  country: string,
): Promise<CourtWeightEntry[]> => {
  const map = await loadCourtWeights();
  const entries = map.get(country);
  return arrayOrEmpty(entries);
};

// -- SQL entries -----------------------------------------------------------

/**
 * Per-map-instance cache of the flattened, sorted entries. `loadCourtWeights`
 * only ever mutates `cached.map` by swapping in a brand-new `Map` on refresh
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

  const entries = [...map.values()].flat().sort(compareCourtWeightPrecedence);
  flattenedEntriesCache.set(map, entries);
  return entries;
};
