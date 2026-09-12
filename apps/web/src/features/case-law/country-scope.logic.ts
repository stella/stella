/**
 * Which public-law screens carry their jurisdiction in the URL, and therefore
 * which ones the top bar offers to switch it on.
 *
 * A decision or an act names its country in its path, so there is nothing to
 * choose there: switching would mean leaving the document. Only the two
 * listing screens are scoped by a `?country=` a reader may change.
 */
export const COUNTRY_SCOPED_LAW_ROUTE_IDS = {
  home: "/law/",
  cases: "/law/cases/",
} as const;

export type CountryScopedLawRoute = keyof typeof COUNTRY_SCOPED_LAW_ROUTE_IDS;

/**
 * Which of the two scoped screens is showing, or null for every other route.
 *
 * Matched on the exact route id rather than a substring: `/law/cases/research`
 * and `/law/$country/cases/...` both contain the same words and neither
 * carries a switchable country.
 */
export const countryScopedLawRoute = (
  routeId: string | null | undefined,
): CountryScopedLawRoute | null => {
  if (routeId === COUNTRY_SCOPED_LAW_ROUTE_IDS.home) {
    return "home";
  }
  if (routeId === COUNTRY_SCOPED_LAW_ROUTE_IDS.cases) {
    return "cases";
  }
  return null;
};
