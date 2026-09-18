/**
 * The jurisdictions the corpus holds decisions for, and the union every
 * per-jurisdiction decision in the case-law slice is total over.
 *
 * The list lives in the contract because three runtimes decide per
 * jurisdiction: the ingestion adapter registry (`SourceAdapter.country` is
 * typed by it, so a new court source cannot be registered without naming its
 * jurisdiction here first), the decision docket grammars, and the readers'
 * statute citation grammars in `@stll/legal-atlas`. Every companion map keyed
 * by `CaseLawJurisdiction`
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
  "HUN",
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
