// parser-output-unchanged: UK_FCL entries extend the key, parser-version and fingerprint maps; existing adapter keys and values are unchanged.
// parser-output-unchanged: the ÚOHS adapter entry is new; existing adapters read only their own keys, so their parsed output is unchanged.
/** Adapter keys for all supported court data sources. */
export const ADAPTER_KEYS = {
  CZ_REGIONAL: "cz-regional",
  CZ_NS: "cz-ns",
  CZ_NSS: "cz-nss",
  CZ_US: "cz-us",
  CZ_UOHS: "cz-uohs",
  SK_COURTS: "sk-courts",
  SK_US: "sk-us",
  PL_COURTS: "pl-courts",
  PL_SN: "pl-sn",
  PL_KIO: "pl-kio",
  PL_TK: "pl-tk",
  PL_NSA: "pl-nsa",
  PL_NCOURT: "pl-ncourt",
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
  HU_BHGY: "hu-bhgy",
  UK_FCL: "uk-fcl",
  PL_KIS: "pl-kis",
  PL_UODO: "pl-uodo",
  PL_UOKIK: "pl-uokik",
} as const;

export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];

/** Import discovery is owned by callers, never the crawl scheduler. */
export const IMPORT_SOURCE_KEYS = {
  COURTLISTENER: "us-courtlistener",
} as const;
export type ImportSourceKey =
  (typeof IMPORT_SOURCE_KEYS)[keyof typeof IMPORT_SOURCE_KEYS];

/**
 * Parser output version for each source.
 *
 * A parser change must only make that source's rows eligible for replay. The
 * total map makes a version decision mandatory whenever an adapter is added;
 * a single global number would turn one publisher's markup fix into a replay
 * of every court corpus.
 */
export const PARSER_VERSIONS = {
  [ADAPTER_KEYS.CZ_REGIONAL]: 16,
  [ADAPTER_KEYS.CZ_NS]: 21,
  [ADAPTER_KEYS.CZ_NSS]: 24,
  [ADAPTER_KEYS.CZ_US]: 32,
  [ADAPTER_KEYS.CZ_UOHS]: 5,
  [ADAPTER_KEYS.SK_COURTS]: 20,
  [ADAPTER_KEYS.SK_US]: 17,
  [ADAPTER_KEYS.PL_COURTS]: 17,
  [ADAPTER_KEYS.PL_SN]: 10,
  [ADAPTER_KEYS.PL_KIO]: 11,
  [ADAPTER_KEYS.PL_TK]: 10,
  [ADAPTER_KEYS.PL_NSA]: 10,
  [ADAPTER_KEYS.PL_NCOURT]: 16,
  [ADAPTER_KEYS.AT_COURTS]: 10,
  [ADAPTER_KEYS.AT_VFGH]: 10,
  [ADAPTER_KEYS.AT_VWGH]: 10,
  [ADAPTER_KEYS.AT_BVWG]: 10,
  [ADAPTER_KEYS.AT_LVWG]: 10,
  [ADAPTER_KEYS.AT_ASYLGH]: 10,
  [ADAPTER_KEYS.AT_UBAS]: 10,
  [ADAPTER_KEYS.AT_UVS]: 10,
  [ADAPTER_KEYS.AT_VERG]: 10,
  [ADAPTER_KEYS.AT_UMSE]: 10,
  [ADAPTER_KEYS.AT_BKS]: 10,
  [ADAPTER_KEYS.AT_FINDOK]: 12,
  [ADAPTER_KEYS.EU_ECJ]: 18,
  [ADAPTER_KEYS.HU_BHGY]: 22,
  [ADAPTER_KEYS.UK_FCL]: 4,
  [ADAPTER_KEYS.PL_KIS]: 11,
  [ADAPTER_KEYS.PL_UODO]: 15,
  [ADAPTER_KEYS.PL_UOKIK]: 12,
} as const satisfies Record<AdapterKey, number>;

// parser-output-unchanged: adds the source fingerprint versions; no parser reads them, so parser output is unchanged.
/**
 * Source fingerprint version for each source.
 *
 * Increment only when a source's fingerprint changes over the same stored
 * bytes: either the adapter changes which already-stored bytes it passes to
 * `sourceFingerprint`, or the hashing itself changes. Changing which bytes an
 * adapter stores is not fingerprint-only: those rows take the normal changed
 * path when next observed, and the parser version changes only when parser
 * output changes.
 */
export const SOURCE_FINGERPRINT_VERSIONS = {
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: 0,
  [ADAPTER_KEYS.CZ_REGIONAL]: 0,
  [ADAPTER_KEYS.CZ_NS]: 0,
  [ADAPTER_KEYS.CZ_NSS]: 0,
  [ADAPTER_KEYS.CZ_US]: 0,
  [ADAPTER_KEYS.CZ_UOHS]: 0,
  [ADAPTER_KEYS.SK_COURTS]: 0,
  [ADAPTER_KEYS.SK_US]: 0,
  [ADAPTER_KEYS.PL_COURTS]: 0,
  [ADAPTER_KEYS.PL_SN]: 0,
  [ADAPTER_KEYS.PL_KIO]: 0,
  [ADAPTER_KEYS.PL_TK]: 0,
  [ADAPTER_KEYS.PL_NSA]: 0,
  [ADAPTER_KEYS.PL_NCOURT]: 0,
  [ADAPTER_KEYS.AT_COURTS]: 0,
  [ADAPTER_KEYS.AT_VFGH]: 0,
  [ADAPTER_KEYS.AT_VWGH]: 0,
  [ADAPTER_KEYS.AT_BVWG]: 0,
  [ADAPTER_KEYS.AT_LVWG]: 0,
  [ADAPTER_KEYS.AT_ASYLGH]: 0,
  [ADAPTER_KEYS.AT_UBAS]: 0,
  [ADAPTER_KEYS.AT_UVS]: 0,
  [ADAPTER_KEYS.AT_VERG]: 0,
  [ADAPTER_KEYS.AT_UMSE]: 0,
  [ADAPTER_KEYS.AT_BKS]: 0,
  [ADAPTER_KEYS.AT_FINDOK]: 0,
  [ADAPTER_KEYS.EU_ECJ]: 0,
  [ADAPTER_KEYS.HU_BHGY]: 0,
  [ADAPTER_KEYS.UK_FCL]: 0,
  [ADAPTER_KEYS.PL_KIS]: 0,
  [ADAPTER_KEYS.PL_UODO]: 0,
  [ADAPTER_KEYS.PL_UOKIK]: 0,
} as const satisfies Record<AdapterKey | ImportSourceKey, number>;

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
