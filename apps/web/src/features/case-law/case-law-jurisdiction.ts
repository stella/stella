import {
  CASE_LAW_REGION_BY_COUNTRY,
  isPublicCaseLawCountry as isSharedPublicCaseLawCountry,
  PUBLIC_CASE_LAW_COUNTRIES as SHARED_PUBLIC_CASE_LAW_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";
import type { UiLocale } from "@stll/locales";

/**
 * The corpus keys decisions by ISO 3166-1 alpha-3 (plus `EU`); display names
 * come from CLDR, which speaks alpha-2 (and knows `EU` as a region).
 */
export const REGION_BY_COUNTRY = CASE_LAW_REGION_BY_COUNTRY;

/** The jurisdictions the case-law browser knows, as the corpus keys them. */
export type CaseLawJurisdiction = keyof typeof REGION_BY_COUNTRY;

const REGIONS: Readonly<Record<string, string>> = REGION_BY_COUNTRY;

export const caseLawCountryRegion = (country: string): string | null =>
  REGIONS[country.toUpperCase()] ?? null;

/** Expects the corpus form (`CZE`), which `fromCaseLawCountryParam` produces. */
export const isCaseLawJurisdiction = (
  country: string,
): country is CaseLawJurisdiction => Object.hasOwn(REGION_BY_COUNTRY, country);

/** The only case-law countries public search may enumerate or query. */
export const PUBLIC_CASE_LAW_COUNTRIES = SHARED_PUBLIC_CASE_LAW_COUNTRIES;

export const isPublicCaseLawCountry = (
  country: string,
): country is CaseLawJurisdiction =>
  isCaseLawJurisdiction(country) && isSharedPublicCaseLawCountry(country);

/** Resolve the route form to a launch-ready corpus country. */
export const publicCaseLawCountryFromParam = (
  param: string | undefined,
): CaseLawJurisdiction | null => {
  if (param === undefined) {
    return null;
  }
  const country = fromCaseLawCountryParam(param);
  return isPublicCaseLawCountry(country) ? country : null;
};

/**
 * The jurisdiction a reader most likely wants, from the language the UI runs
 * in. A locale without a launch-ready match falls back to the first country
 * in the generated list, so public queries always carry an explicit scope.
 */
const DEFAULT_COUNTRY_BY_LOCALE = {
  ar: null,
  cs: "CZE",
  de: null,
  en: null,
  es: null,
  et: null,
  fr: null,
  hu: null,
  lt: null,
  lv: null,
  pl: "POL",
  "pt-BR": null,
  sk: "SVK",
} as const satisfies Record<UiLocale, CaseLawJurisdiction | null>;

export const defaultCaseLawCountryForLocale = (
  locale: UiLocale,
): CaseLawJurisdiction | null => {
  const localeCountry = DEFAULT_COUNTRY_BY_LOCALE[locale];
  return localeCountry !== null && isPublicCaseLawCountry(localeCountry)
    ? localeCountry
    : (PUBLIC_CASE_LAW_COUNTRIES.at(0) ?? null);
};

/** The URL form of a corpus country code, and back. */
export const toCaseLawCountryParam = (country: string): string =>
  country.toLowerCase();

export const fromCaseLawCountryParam = (param: string): string =>
  param.toUpperCase();
