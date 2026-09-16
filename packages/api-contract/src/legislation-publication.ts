import type { CaseLawJurisdiction } from "./case-law-jurisdictions";

/** Statute jurisdictions admitted to public readers; independent of case-law readiness. */
export const PUBLIC_LEGISLATION_COUNTRIES = [
  "CZE",
] as const satisfies readonly CaseLawJurisdiction[];

export const isPublicLegislationCountry = (country: string): boolean =>
  PUBLIC_LEGISLATION_COUNTRIES.some((candidate) => candidate === country);
