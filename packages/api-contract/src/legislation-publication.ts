/** Statute jurisdictions admitted to public readers; independent of case-law readiness. */
export const PUBLIC_LEGISLATION_COUNTRIES = ["CZE"] as const;

export type PublicLegislationCountry =
  (typeof PUBLIC_LEGISLATION_COUNTRIES)[number];

export const isPublicLegislationCountry = (country: string): boolean =>
  PUBLIC_LEGISLATION_COUNTRIES.some((candidate) => candidate === country);

/**
 * The admitted jurisdiction a caller's country code names, or null.
 *
 * Case folding happens here rather than at each call site: the codes are
 * canonically uppercase, and a model writing `cze` means the same
 * jurisdiction. The twin for case law is `publicCaseLawCountry`.
 */
export const publicLegislationCountry = (
  country: string,
): PublicLegislationCountry | null => {
  const canonical = country.trim().toUpperCase();
  return (
    PUBLIC_LEGISLATION_COUNTRIES.find((candidate) => candidate === canonical) ??
    null
  );
};
