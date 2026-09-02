import type { UiLocale } from "@stll/locales";

/** URL value of the jurisdiction pill meaning "every country in the corpus". */
export const CASE_LAW_ALL_COUNTRIES = "all";

/**
 * The jurisdiction a reader most likely wants, from the language the UI runs
 * in. Only where the language maps to one legal system the corpus covers; a
 * reader in any other language starts unscoped and picks.
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
} as const satisfies Record<UiLocale, string | null>;

export const defaultCaseLawCountryForLocale = (
  locale: UiLocale,
): string | null => DEFAULT_COUNTRY_BY_LOCALE[locale];

/**
 * The corpus keys decisions by ISO 3166-1 alpha-3 (plus `EU`); display names
 * come from CLDR, which speaks alpha-2 (and knows `EU` as a region).
 */
export const REGION_BY_COUNTRY = {
  CZE: "CZ",
  EU: "EU",
  POL: "PL",
  SVK: "SK",
} as const satisfies Record<string, string>;

/** The jurisdictions the public law browsers know, as the corpus keys them. */
export type CaseLawJurisdiction = keyof typeof REGION_BY_COUNTRY;

const REGIONS: Readonly<Record<string, string>> = REGION_BY_COUNTRY;

export const caseLawCountryRegion = (country: string): string | null =>
  REGIONS[country.toUpperCase()] ?? null;

/** Expects the corpus form (`CZE`), which `fromCaseLawCountryParam` produces. */
export const isCaseLawJurisdiction = (
  country: string,
): country is CaseLawJurisdiction => Object.hasOwn(REGION_BY_COUNTRY, country);

/** The URL form of a corpus country code, and back. */
export const toCaseLawCountryParam = (country: string): string =>
  country.toLowerCase();

export const fromCaseLawCountryParam = (param: string): string =>
  param.toUpperCase();
