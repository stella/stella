/**
 * FTS configuration resolver for case law decisions.
 *
 * Maps ISO 639-1 language codes to PostgreSQL regconfig names,
 * backed by the `case_law_fts_configs` table with in-memory cache.
 */

import { db } from "@/api/db";
import { caseLawFtsConfigs } from "@/api/db/schema";

// -- Types ---------------------------------------------------------------

export type FtsConfig = {
  regconfig: string;
  useUnaccent: boolean;
};

// -- Cache ---------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const DEFAULT_CONFIG: FtsConfig = {
  regconfig: "simple",
  useUnaccent: true,
};

let cached: {
  map: Map<string, FtsConfig>;
  expiresAt: number;
} | null = null;

/** Load FTS configs from the database, caching for 60 s. */
export const loadFtsConfigs = async (): Promise<Map<string, FtsConfig>> => {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.map;
  }

  const rows = await db.select().from(caseLawFtsConfigs);

  const map = new Map<string, FtsConfig>();
  for (const row of rows) {
    map.set(row.language, {
      regconfig: row.regconfig,
      useUnaccent: row.useUnaccent,
    });
  }

  cached = { map, expiresAt: Date.now() + CACHE_TTL_MS };
  return map;
};

/** Resolve regconfig + unaccent for a language code. */
export const resolveFtsConfig = async (
  language: string | null | undefined,
): Promise<FtsConfig> => {
  if (!language) {
    return DEFAULT_CONFIG;
  }

  const configs = await loadFtsConfigs();
  return configs.get(language) ?? DEFAULT_CONFIG;
};

/** Invalidate the cache (e.g. after seeding). */
export const invalidateFtsConfigsCache = (): void => {
  cached = null;
};
