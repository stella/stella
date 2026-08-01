/** Adapter keys for all supported court data sources. */
export const ADAPTER_KEYS = {
  CZ_REGIONAL: "cz-regional",
  CZ_NS: "cz-ns",
  CZ_NSS: "cz-nss",
  CZ_US: "cz-us",
  SK_COURTS: "sk-courts",
  SK_US: "sk-us",
  PL_COURTS: "pl-courts",
  AT_COURTS: "at-courts",
  EU_ECJ: "eu-ecj",
} as const;

export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];

/**
 * Global parser version. Bump when ANY parser's AST output
 * changes. Stale decisions (parserVersion < PARSER_VERSION)
 * are re-parsed lazily from sourceRaw on next user access.
 */
export const PARSER_VERSION = 2;

/** Maximum number of pages to sync per invocation. */
export const MAX_SYNC_PAGES = 100;

/**
 * Adapter fetch timeouts (ms).
 *
 * REQUEST: default per-request timeout (single-item fetches,
 *   lightweight page requests).
 * LIST: paginated list/search requests to heavier APIs
 *   (SK list, PL SAOS).
 * PAGE: pipeline-level timeout wrapping each fetchPage call.
 */
export const ADAPTER_TIMEOUT = {
  REQUEST: 10_000,
  LIST: 15_000,
  PAGE: 30_000,
} as const;

/** Maximum time (ms) for a single adapter cycle. */
export const MAX_CYCLE_MS = 10 * 60 * 1000;
