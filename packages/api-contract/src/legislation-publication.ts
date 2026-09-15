/** Statute jurisdictions admitted to public readers; independent of case-law readiness. */
export const PUBLIC_LEGISLATION_COUNTRIES = ["CZE"] as const;

export const isPublicLegislationCountry = (country: string): boolean =>
  PUBLIC_LEGISLATION_COUNTRIES.some((candidate) => candidate === country);
