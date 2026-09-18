/** Adapter keys for all supported court data sources. */
export const ADAPTER_KEYS = {
  CZ_REGIONAL: "cz-regional",
  CZ_NS: "cz-ns",
  CZ_NSS: "cz-nss",
  CZ_US: "cz-us",
  SK_COURTS: "sk-courts",
  SK_US: "sk-us",
  PL_COURTS: "pl-courts",
  PL_SN: "pl-sn",
  AT_COURTS: "at-courts",
  AT_VFGH: "at-vfgh",
  AT_VWGH: "at-vwgh",
  AT_BVWG: "at-bvwg",
  AT_LVWG: "at-lvwg",
  AT_ASYLGH: "at-asylgh",
  AT_UBAS: "at-ubas",
  AT_UVS: "at-uvs",
  AT_VERG: "at-verg",
  AT_UMSE: "at-umse",
  AT_BKS: "at-bks",
  AT_FINDOK: "at-findok",
  EU_ECJ: "eu-ecj",
} as const;

export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];

/**
 * Parser output version for each source.
 *
 * A parser change must only make that source's rows eligible for replay. The
 * total map makes a version decision mandatory whenever an adapter is added;
 * a single global number would turn one publisher's markup fix into a replay
 * of every court corpus.
 */
export const PARSER_VERSIONS = {
  [ADAPTER_KEYS.CZ_REGIONAL]: 3,
  [ADAPTER_KEYS.CZ_NS]: 3,
  [ADAPTER_KEYS.CZ_NSS]: 6,
  [ADAPTER_KEYS.CZ_US]: 5,
  [ADAPTER_KEYS.SK_COURTS]: 3,
  [ADAPTER_KEYS.SK_US]: 2,
  [ADAPTER_KEYS.PL_COURTS]: 2,
  [ADAPTER_KEYS.PL_SN]: 1,
  [ADAPTER_KEYS.AT_COURTS]: 2,
  [ADAPTER_KEYS.AT_VFGH]: 2,
  [ADAPTER_KEYS.AT_VWGH]: 2,
  [ADAPTER_KEYS.AT_BVWG]: 2,
  [ADAPTER_KEYS.AT_LVWG]: 2,
  [ADAPTER_KEYS.AT_ASYLGH]: 2,
  [ADAPTER_KEYS.AT_UBAS]: 2,
  [ADAPTER_KEYS.AT_UVS]: 2,
  [ADAPTER_KEYS.AT_VERG]: 2,
  [ADAPTER_KEYS.AT_UMSE]: 2,
  [ADAPTER_KEYS.AT_BKS]: 2,
  [ADAPTER_KEYS.AT_FINDOK]: 2,
  [ADAPTER_KEYS.EU_ECJ]: 5,
} as const satisfies Record<AdapterKey, number>;

/**
 * Capacity bound for a complete `case_law_sources` read, and nothing more.
 *
 * Deliberately NOT `ADAPTER_KEYS.length`. The registry is deployment state
 * while the rows are history: a retired adapter leaves its row behind, a
 * seeded environment carries fixture sources, and a test creates its own. All
 * three are legitimate rows that a registry-sized bound would turn into a
 * panic, in the operational views that exist to explain the corpus.
 *
 * Generous on purpose. The number is not a claim about which sources exist —
 * that question is answered at read time, per row, against the registry — it
 * is the point past which a complete read stops being a bounded one and the
 * table has clearly grown a shape nobody designed.
 */
export const CASE_LAW_SOURCE_ROWS_BOUND = 64;

export const CASE_LAW_SOURCE_ROWS_INVARIANT =
  "case_law_sources is an operator-curated catalogue of at most a few dozen rows; the adapter registry is validated per row at read time, not by this bound";

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
