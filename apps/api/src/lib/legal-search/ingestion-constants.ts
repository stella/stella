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
 * The jurisdictions the corpus holds decisions for, and the union every
 * per-jurisdiction decision in the case-law slice is total over.
 *
 * Declared beside the adapter registry because the registry is what creates a
 * jurisdiction: `SourceAdapter.country` is typed by this list, so a new court
 * source cannot be registered without naming its jurisdiction here first. Every
 * companion map keyed by `CaseLawJurisdiction`
 * (`as const satisfies Record<CaseLawJurisdiction, …>`) then fails to compile
 * until the new member has a declared policy, which is the point: onboarding a
 * jurisdiction is a series of decisions, and the compiler is what enumerates
 * them rather than a checklist someone has to remember.
 *
 * ISO 3166-1 alpha-3, plus `EU` for the Court of Justice, which is
 * supranational rather than a country. The pseudo-code is deliberate: it makes
 * "which decisions may a citation from here reach" a per-jurisdiction
 * declaration instead of a special case in the resolver.
 */
export const CASE_LAW_JURISDICTIONS = [
  "AUT",
  "CZE",
  "EU",
  "POL",
  "SVK",
] as const;

export type CaseLawJurisdiction = (typeof CASE_LAW_JURISDICTIONS)[number];

/**
 * Narrow a stored country code to a declared jurisdiction.
 *
 * The registry types what adapters write, but a decision row is history: a
 * source retired before this list existed, or a fixture, can hold a code
 * nobody declares a policy for. Callers that must decide per jurisdiction
 * narrow here and handle the miss loudly rather than defaulting.
 */
export const isCaseLawJurisdiction = (
  value: string,
): value is CaseLawJurisdiction =>
  CASE_LAW_JURISDICTIONS.some((jurisdiction) => jurisdiction === value);

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
