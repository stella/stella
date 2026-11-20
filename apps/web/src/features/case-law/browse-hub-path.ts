import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "./case-law-jurisdiction";

/**
 * The jurisdiction hub's address, and what the route heads ask of a URL. The
 * heads of the law routes run in the route tree every cold visit loads, so
 * this module stays this small; the browse tree's paths and labels
 * (`browse-path.ts`) load with the hub pages.
 */

export const createCaseLawJurisdictionHubPath = (
  countryParam: string,
): `/law/${string}` => `/law/${countryParam}`;

/**
 * The hub a search, filter or home URL scoped to `country` stands in for, or
 * null when the country has no public pages.
 */
export const publicCaseLawHubPathFor = (
  country: string | undefined,
): `/law/${string}` | null => {
  const scope =
    country === undefined ? null : publicCaseLawPageCountryFromParam(country);
  return scope === null
    ? null
    : createCaseLawJurisdictionHubPath(toCaseLawCountryParam(scope));
};

/** Whether a route's parsed search carries any parameter at all. */
export const hasSearch = (search: object): boolean =>
  Object.keys(search).length > 0;
