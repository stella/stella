/**
 * FTS configuration resolver for case law decisions.
 *
 * Maps ISO 639-1 language codes to PostgreSQL regconfig names,
 * backed by the `case_law_fts_configs` table with in-memory cache.
 */

import { readFtsConfigRows } from "@/api/lib/case-law/case-law-config-store";

// -- Types ---------------------------------------------------------------

export type FtsConfig = {
  regconfig: string;
  useUnaccent: boolean;
};

export type FtsSearchConfig = FtsConfig & {
  includeDefault: boolean;
  languages: readonly string[];
};

// -- Cache ---------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
export const DEFAULT_FTS_CONFIG: FtsConfig = {
  regconfig: "simple",
  useUnaccent: true,
};

let cached: {
  map: Map<string, FtsConfig>;
  expiresAt: number;
} | null = null;

/** Load FTS configs from the database, caching for 60 s. */
const loadFtsConfigs = async (): Promise<Map<string, FtsConfig>> => {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.map;
  }

  const rows = await readFtsConfigRows();

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
    return DEFAULT_FTS_CONFIG;
  }

  const configs = await loadFtsConfigs();
  return configs.get(language) ?? DEFAULT_FTS_CONFIG;
};

export const loadFtsSearchConfigs = async (): Promise<FtsSearchConfig[]> => {
  const configs = await loadFtsConfigs();
  const groups = new Map<string, FtsSearchConfig>();

  for (const [language, config] of configs) {
    const key = `${config.regconfig}:${config.useUnaccent}`;
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, {
        ...existing,
        languages: [...existing.languages, language],
      });
      continue;
    }

    groups.set(key, {
      ...config,
      includeDefault: false,
      languages: [language],
    });
  }

  const defaultKey = `${DEFAULT_FTS_CONFIG.regconfig}:${DEFAULT_FTS_CONFIG.useUnaccent}`;
  const defaultGroup = groups.get(defaultKey);
  if (defaultGroup) {
    groups.set(defaultKey, { ...defaultGroup, includeDefault: true });
  } else {
    groups.set(defaultKey, {
      ...DEFAULT_FTS_CONFIG,
      includeDefault: true,
      languages: [],
    });
  }

  return [...groups.values()];
};

/** Invalidate the cache (e.g. after seeding). */
export const invalidateFtsConfigsCache = (): void => {
  cached = null;
};
