/**
 * Dynamic court weight loader with in-memory cache.
 *
 * Replaces the hardcoded COURT_TIERS array in citation-score.ts
 * with database-driven weights per jurisdiction.
 */

import { readCourtWeightRows } from "@/api/lib/case-law/case-law-config-store";

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

  const map: CourtWeightMap = new Map();
  for (const row of rows) {
    const entries = map.get(row.country) ?? [];
    entries.push({
      pattern: new RegExp(row.courtPattern, "i"),
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
  return map.get(country) ?? [];
};
