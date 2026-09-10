import { panic } from "better-result";
import * as v from "valibot";

import type { UiLocale } from "@stll/locales";

import launchReadiness from "@/features/case-law/launch-readiness.json";

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

/** The jurisdictions the case-law browser knows, as the corpus keys them. */
export type CaseLawJurisdiction = keyof typeof REGION_BY_COUNTRY;

const REGIONS: Readonly<Record<string, string>> = REGION_BY_COUNTRY;

export const caseLawCountryRegion = (country: string): string | null =>
  REGIONS[country.toUpperCase()] ?? null;

/** Expects the corpus form (`CZE`), which `fromCaseLawCountryParam` produces. */
export const isCaseLawJurisdiction = (
  country: string,
): country is CaseLawJurisdiction => Object.hasOwn(REGION_BY_COUNTRY, country);

const launchReadinessEntrySchema = v.strictObject({
  country: v.string(),
  evalSetExists: v.literal(true),
  lastCensusDate: v.pipe(v.string(), v.isoDate()),
  lastCensusGreen: v.literal(true),
});

const launchReadinessSchema = v.array(launchReadinessEntrySchema);

/**
 * The generated artifact is an inclusion list: every row carries both facts
 * needed for its country to appear publicly. Sorted unique rows keep updates
 * deterministic and make a repeated country invalid rather than ambiguous.
 */
export const parseCaseLawLaunchReadiness = (
  value: unknown,
): readonly CaseLawJurisdiction[] => {
  const result = v.safeParse(launchReadinessSchema, value);
  if (!result.success) {
    return panic(
      "Launch readiness must contain only complete entries with ISO dates.",
    );
  }

  const countries: CaseLawJurisdiction[] = [];
  let previous: CaseLawJurisdiction | null = null;
  for (const { country } of result.output) {
    if (!isCaseLawJurisdiction(country)) {
      return panic("Launch readiness contains an unsupported country.");
    }
    if (previous !== null && previous >= country) {
      return panic("Launch readiness countries must be unique and sorted.");
    }
    countries.push(country);
    previous = country;
  }

  return countries;
};

/** The only case-law countries public search may enumerate or query. */
export const PUBLIC_CASE_LAW_COUNTRIES =
  parseCaseLawLaunchReadiness(launchReadiness);

export const isPublicCaseLawCountry = (
  country: string,
): country is CaseLawJurisdiction =>
  PUBLIC_CASE_LAW_COUNTRIES.some((candidate) => candidate === country);

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
