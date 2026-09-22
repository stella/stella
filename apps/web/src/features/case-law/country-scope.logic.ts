/**
 * Which public-law screens carry a switchable jurisdiction, and therefore
 * which ones the top bar offers to switch it on.
 *
 * A decision or an act names its country in its path, so there is nothing to
 * choose there: switching would mean leaving the document. Only the listing
 * screens are scoped by a country a reader may change: the home and the
 * case-law list by `?country=`, the statute list by its `$country` segment.
 */
export const COUNTRY_SCOPED_LAW_ROUTE_IDS = {
  home: "/law/",
  cases: "/law/cases/",
  statutes: "/law/$country/statutes/",
} as const;

export type CountryScopedLawRoute = keyof typeof COUNTRY_SCOPED_LAW_ROUTE_IDS;

const isCountryScopedLawRoute = (
  value: string,
): value is CountryScopedLawRoute =>
  Object.hasOwn(COUNTRY_SCOPED_LAW_ROUTE_IDS, value);

/**
 * Which of the scoped screens is showing, or null for every other route.
 *
 * Matched on the exact route id rather than a substring: `/law/cases/research`
 * and `/law/$country/cases/...` both contain the same words and neither
 * carries a switchable country.
 */
export const countryScopedLawRoute = (
  routeId: string | null | undefined,
): CountryScopedLawRoute | null => {
  for (const route of Object.keys(COUNTRY_SCOPED_LAW_ROUTE_IDS)) {
    if (
      isCountryScopedLawRoute(route) &&
      COUNTRY_SCOPED_LAW_ROUTE_IDS[route] === routeId
    ) {
      return route;
    }
  }
  return null;
};
