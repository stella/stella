import { CASE_LAW_REGION_BY_JURISDICTION } from "@stll/api-contract/case-law-jurisdictions";
import {
  CASE_LAW_REGION_BY_COUNTRY,
  isPublicCaseLawCountry as isSharedPublicCaseLawCountry,
  PUBLIC_CASE_LAW_COUNTRIES as SHARED_PUBLIC_CASE_LAW_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";
import type {
  CaseLawBrowserCountry,
  PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

/**
 * The corpus keys decisions by ISO 3166-1 alpha-3 (plus `EU`); display names
 * come from CLDR, which speaks alpha-2 (and knows `EU` as a region).
 */
export const REGION_BY_COUNTRY = CASE_LAW_REGION_BY_COUNTRY;

// Names come from the map over every jurisdiction, not the browser's: the
// coverage page reports a jurisdiction before the public search admits it,
// and its name must not arrive as a bare code.
const REGIONS: Readonly<Record<string, string>> =
  CASE_LAW_REGION_BY_JURISDICTION;

export const caseLawCountryRegion = (country: string): string | null =>
  REGIONS[country.toUpperCase()] ?? null;

/** Expects the corpus form (`CZE`), which `fromCaseLawCountryParam` produces. */
export const isCaseLawBrowserCountry = (
  country: string,
): country is CaseLawBrowserCountry =>
  Object.hasOwn(REGION_BY_COUNTRY, country);

/** The only case-law countries public search may enumerate or query. */
export const PUBLIC_CASE_LAW_COUNTRIES = SHARED_PUBLIC_CASE_LAW_COUNTRIES;

export const isPublicCaseLawCountry = (
  country: string,
): country is PublicCaseLawCountry =>
  isCaseLawBrowserCountry(country) && isSharedPublicCaseLawCountry(country);

/** Resolve the route form to a launch-ready corpus country. */
export const publicCaseLawCountryFromParam = (
  param: string | undefined,
): PublicCaseLawCountry | null => {
  if (param === undefined) {
    return null;
  }
  const country = fromCaseLawCountryParam(param);
  return isPublicCaseLawCountry(country) ? country : null;
};

/** The URL form of a corpus country code, and back. */
export const toCaseLawCountryParam = (country: string): string =>
  country.toLowerCase();

export const fromCaseLawCountryParam = (param: string): string =>
  param.toUpperCase();

/**
 * The corpus country the pill names. A URL without a country is scoped by
 * `beforeLoad` before public search calls this helper.
 */
export const caseLawCountryScope = (
  country: string | undefined,
): string | undefined =>
  country === undefined ? undefined : fromCaseLawCountryParam(country);
