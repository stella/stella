/**
 * Dynamic court weight loader with in-memory cache.
 *
 * Replaces the hardcoded COURT_TIERS array in citation-score.ts
 * with database-driven weights per jurisdiction.
 */

import { arrayOrEmpty } from "@/api/lib/array";
import { readCourtWeightRows } from "@/api/lib/case-law/case-law-config-store";
import { logger } from "@/api/lib/observability/logger";

// -- Types ---------------------------------------------------------------

export type CourtWeightEntry = {
  pattern: RegExp;
  tier: number;
  tierLabel: string;
  weight: number;
};

/** Country code → compiled weight entries. */
export type CourtWeightMap = Map<string, CourtWeightEntry[]>;

// -- Cache ---------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

let cached: { map: CourtWeightMap; expiresAt: number } | null = null;

/** Load court weights from the database, caching for 60 s. */
export const loadCourtWeights = async (): Promise<CourtWeightMap> => {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.map;
  }

  const rows = await readCourtWeightRows();

  if (rows.length === 0) {
    // Self-host before seeding, or a fresh environment that has not run
    // seed-court-weights.ts yet: callers fall back to the hardcoded
    // LEGACY_COURT_TIERS in citation-score.ts. Surface this so an
    // unseeded production table is visible rather than silently ranking
    // every non-CZ/SK court the same.
    logger.warn("case_law.court_weights.table_empty", {
      fallback: "legacy_hardcoded_tiers",
    });
  }

  const map: CourtWeightMap = new Map();
  for (const row of rows) {
    const storedEntries = map.get(row.country);
    const entries = arrayOrEmpty(storedEntries);
    entries.push({
      pattern: new RegExp(row.courtPattern, "iu"),
      tier: row.tier,
      tierLabel: row.tierLabel,
      weight: row.weight,
    });
    map.set(row.country, entries);
  }

  // Sort each country's entries by tier descending so highest
  // authority matches first.
  for (const entries of map.values()) {
    entries.sort((a, b) => b.tier - a.tier);
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
 * Return the weight for a court name using the loaded map.
 * Falls back to DEFAULT_WEIGHT if no pattern matches.
 */
export const courtWeightFromMap = (
  map: CourtWeightMap,
  court: string,
  country?: string,
): { weight: number; tier: number } => {
  // If country is known, check only that country's entries.
  if (country) {
    const entries = map.get(country);
    if (entries) {
      for (const e of entries) {
        if (e.pattern.test(court)) {
          return { weight: e.weight, tier: e.tier };
        }
      }
    }
  }

  // Fallback: check all countries (slower but handles
  // cross-jurisdiction lookups).
  for (const entries of map.values()) {
    for (const e of entries) {
      if (e.pattern.test(court)) {
        return { weight: e.weight, tier: e.tier };
      }
    }
  }

  return { weight: DEFAULT_WEIGHT, tier: DEFAULT_TIER };
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
 * Flatten every country's entries into one list, sorted by tier
 * descending so the highest-authority pattern is checked first.
 *
 * For building a single SQL `CASE` expression (`courtWeightSql`) that is
 * not scoped to one jurisdiction — citation graphs cross borders, so the
 * citing court in `citation-authority.ts` and `decisions/search.ts` can
 * belong to any seeded country.
 *
 * Returns `undefined` when the map is empty so callers can pass that
 * straight to `courtWeightSql`'s `entries` parameter: an empty array
 * would short-circuit its `entries ?? LEGACY_COURT_TIERS` fallback,
 * silently disabling the legacy tiers instead of falling back to them.
 */
export const flattenCourtWeightEntries = (
  map: CourtWeightMap,
): CourtWeightEntry[] | undefined => {
  const entries = [...map.values()].flat().sort((a, b) => b.tier - a.tier);
  return entries.length > 0 ? entries : undefined;
};

/**
 * Load and flatten court weights for a cross-jurisdiction SQL `CASE`
 * expression. See `flattenCourtWeightEntries`.
 */
export const loadCourtWeightEntriesForSql = async (): Promise<
  CourtWeightEntry[] | undefined
> => flattenCourtWeightEntries(await loadCourtWeights());
