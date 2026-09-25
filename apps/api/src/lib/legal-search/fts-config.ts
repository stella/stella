import { Temporal } from "@stll/time";
/**
 * FTS configuration resolver for case law decisions.
 *
 * Maps ISO 639-1 language codes to PostgreSQL regconfig names, backed by the
 * `case_law_fts_configs` table with an in-memory cache per source. A search
 * document's `regconfig` and `tsv` are built with the configuration of the
 * database that holds it, so a query has to be parsed with that same
 * database's configuration: the public corpus and the local one each own an
 * instance (`public-case-law-config.ts`, `local-case-law-config.ts`).
 */

import type { FtsConfigRow } from "@/api/lib/case-law/case-law-config-read";

// -- Types ---------------------------------------------------------------

export type FtsConfig = {
  regconfig: string;
  useUnaccent: boolean;
};

export type FtsSearchConfig = FtsConfig & {
  includeDefault: boolean;
  languages: readonly string[];
};

/** One source's configurations, cached for 60 s. */
export type FtsConfigCache = {
  /** Resolve regconfig + unaccent for a language code. */
  resolveFtsConfig: (language: string | null | undefined) => Promise<FtsConfig>;
  /** Every configuration, grouped the way a query branches on them. */
  loadFtsSearchConfigs: () => Promise<FtsSearchConfig[]>;
  /** Drop the cached configurations (e.g. after seeding). */
  invalidate: () => void;
};

// -- Cache ---------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
export const DEFAULT_FTS_CONFIG: FtsConfig = {
  regconfig: "simple",
  useUnaccent: true,
};

const ftsSearchConfigsFrom = (
  configs: ReadonlyMap<string, FtsConfig>,
): FtsSearchConfig[] => {
  const groups = new Map<
    string,
    FtsConfig & { includeDefault: boolean; languages: string[] }
  >();

  for (const [language, config] of configs) {
    const key = `${config.regconfig}:${config.useUnaccent}`;
    const existing = groups.get(key);
    if (existing) {
      existing.languages.push(language);
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

/**
 * A configuration cache over one source's rows. The source decides which
 * database the configurations come from; the cache keeps it to one read a
 * minute and never answers from another source's rows.
 */
export const createFtsConfigCache = (
  readRows: () => Promise<readonly FtsConfigRow[]>,
): FtsConfigCache => {
  let cached: {
    map: Map<string, FtsConfig>;
    expiresAt: number;
  } | null = null;

  const loadFtsConfigs = async (): Promise<Map<string, FtsConfig>> => {
    if (cached && Temporal.Now.instant().epochMilliseconds < cached.expiresAt) {
      return cached.map;
    }

    const rows = await readRows();

    const map = new Map<string, FtsConfig>();
    for (const row of rows) {
      map.set(row.language, {
        regconfig: row.regconfig,
        useUnaccent: row.useUnaccent,
      });
    }

    cached = {
      map,
      expiresAt: Temporal.Now.instant().epochMilliseconds + CACHE_TTL_MS,
    };
    return map;
  };

  return {
    resolveFtsConfig: async (language) => {
      if (!language) {
        return DEFAULT_FTS_CONFIG;
      }

      const configs = await loadFtsConfigs();
      return configs.get(language) ?? DEFAULT_FTS_CONFIG;
    },
    loadFtsSearchConfigs: async () =>
      ftsSearchConfigsFrom(await loadFtsConfigs()),
    invalidate: () => {
      cached = null;
    },
  };
};
