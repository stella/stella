/**
 * City dictionaries and the full dictionary bundle.
 *
 * A separate entry on purpose: `CITY_LOADERS` holds one
 * literal `import()` per covered country, so any module
 * graph that reaches it makes a bundler emit all ~237
 * city chunks. Keeping the city API out of the root
 * entry lets a consumer that only wants, say, name
 * dictionaries pay nothing for cities.
 *
 * City dictionaries come from GeoNames (CC BY 4.0,
 * pop > 5,000). They are keyed by country code in
 * CITY_LOADERS rather than registered in
 * DICTIONARY_META, because the number of countries
 * would bloat the static type system.
 */

import type { CityCountryCode } from "./city-loaders";
import { CITY_LOADERS } from "./city-loaders";
import type { DictionaryId, DictionaryMeta, NameLanguage } from "./index";
import {
  ALL_DICTIONARY_IDS,
  DICTIONARY_META,
  loadDictionary,
  loadNameDictionaries,
  NAME_LANGUAGES,
} from "./index";

const cityCache = new Map<string, readonly string[]>();

const NO_CITY_DICTIONARY: readonly string[] = [];

/** Country codes with a bundled city dictionary. */
export const CITY_DICTIONARY_COUNTRIES: readonly string[] =
  Object.keys(CITY_LOADERS);

const isCityCountryCode = (code: string): code is CityCountryCode =>
  code in CITY_LOADERS;

/**
 * True when a city dictionary is bundled for the
 * country. Distinguishes "not covered" from a covered
 * country whose dictionary failed to load.
 *
 * @param countryCode ISO 3166-1 alpha-2 (e.g., "HU")
 */
export const hasCityDictionary = (countryCode: string): boolean =>
  isCityCountryCode(countryCode.toUpperCase());

const loadCityEntries = async (
  cc: CityCountryCode,
): Promise<readonly string[]> => {
  try {
    const mod = await CITY_LOADERS[cc]();
    return mod.default;
  } catch (cause) {
    throw new Error(`Failed to load the city dictionary for ${cc}`, { cause });
  }
};

/**
 * Load city names for a country.
 *
 * Returns an empty array when no dictionary is bundled
 * for the country; check coverage up front with
 * `hasCityDictionary`. A covered country whose
 * dictionary fails to load throws, because silently
 * degrading to zero city names under-redacts without
 * any signal.
 *
 * @param countryCode ISO 3166-1 alpha-2 (e.g., "HU")
 */
export const loadCityDictionary = async (
  countryCode: string,
): Promise<readonly string[]> => {
  const cc = countryCode.toUpperCase();
  const cached = cityCache.get(cc);
  if (cached) {
    return cached;
  }

  if (!isCityCountryCode(cc)) {
    cityCache.set(cc, NO_CITY_DICTIONARY);
    return NO_CITY_DICTIONARY;
  }

  const entries = await loadCityEntries(cc);
  cityCache.set(cc, entries);
  return entries;
};

/**
 * Load city dictionaries for multiple countries.
 * Returns merged array of all city names.
 */
export const loadCityDictionaries = async (
  countryCodes: readonly string[],
): Promise<readonly string[]> => {
  const results = await Promise.all(countryCodes.map(loadCityDictionary));
  const merged: string[] = [];
  for (const entries of results) {
    for (const entry of entries) {
      merged.push(entry);
    }
  }
  return merged;
};

/** City dictionary metadata (same for all countries). */
export const CITY_DICTIONARY_META: DictionaryMeta = {
  label: "address",
  category: "Places",
  country: null,
};

// ── Full dictionary bundle ────────────────────────────

export type DictionaryBundle = {
  firstNames: Record<string, readonly string[]>;
  surnames: Record<string, readonly string[]>;
  denyList: Record<string, readonly string[]>;
  denyListMeta: Record<string, DictionaryMeta>;
  cities: readonly string[];
  citiesByCountry: Record<string, readonly string[]>;
};

export type LoadDictionaryBundleOptions = {
  countries?: readonly string[];
  cityCountries?: readonly string[];
  nameLanguages?: readonly string[];
};

const DEFAULT_CITY_COUNTRIES = [
  "AT",
  "AU",
  "BE",
  "BG",
  "BR",
  "CA",
  "CH",
  "CZ",
  "DE",
  "DK",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LU",
  "NL",
  "NO",
  "NZ",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "US",
] as const;

const normalizeCountryCodes = (
  countries: readonly string[] | undefined,
): Set<string> | null => {
  if (countries === undefined || countries.length === 0) {
    return null;
  }
  return new Set(countries.map((country) => country.toUpperCase()));
};

const isNameLanguage = (language: string): language is NameLanguage =>
  NAME_LANGUAGES.some((supported) => supported === language);

const normalizeNameLanguages = (
  languages: readonly string[] | undefined,
): NameLanguage[] => {
  if (languages === undefined || languages.length === 0) {
    return [...NAME_LANGUAGES];
  }
  const result: NameLanguage[] = [];
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (isNameLanguage(normalized)) {
      result.push(normalized);
    }
  }
  return result;
};

const dictionaryIdIsInScope = (
  id: DictionaryId,
  countries: Set<string> | null,
  hasScopedNames: boolean,
): boolean => {
  const meta = DICTIONARY_META[id];
  if (hasScopedNames && meta.category === "Names") {
    return false;
  }
  return (
    countries === null || meta.country === null || countries.has(meta.country)
  );
};

export const loadDictionaryBundle = async ({
  countries,
  cityCountries,
  nameLanguages,
}: LoadDictionaryBundleOptions = {}): Promise<DictionaryBundle> => {
  const countryScope = normalizeCountryCodes(countries);
  const scopedNameLanguages = normalizeNameLanguages(nameLanguages);
  const hasScopedNames =
    nameLanguages !== undefined && nameLanguages.length > 0;
  const dictionaryIds = ALL_DICTIONARY_IDS.filter((id) =>
    dictionaryIdIsInScope(id, countryScope, hasScopedNames),
  );
  const dictionaryResults = await Promise.all(
    dictionaryIds.map(async (id) => ({
      id,
      entries: await loadDictionary(id),
    })),
  );
  const denyList: Record<string, readonly string[]> = {};
  const denyListMeta: Record<string, DictionaryMeta> = {};
  for (const { id, entries } of dictionaryResults) {
    denyList[id] = entries;
    denyListMeta[id] = DICTIONARY_META[id];
  }

  const nameDictionaries = await loadNameDictionaries(
    hasScopedNames ? scopedNameLanguages : undefined,
  );
  const requestedCityScope = cityCountries ?? countries;
  const cityScope =
    requestedCityScope === undefined || requestedCityScope.length === 0
      ? DEFAULT_CITY_COUNTRIES
      : requestedCityScope;
  const cityResults = await Promise.all(
    cityScope.map(async (country) => ({
      country: country.toUpperCase(),
      entries: await loadCityDictionary(country),
    })),
  );
  const citiesByCountry: Record<string, readonly string[]> = {};
  const cities: string[] = [];
  for (const { country, entries } of cityResults) {
    citiesByCountry[country] = entries;
    for (const entry of entries) {
      cities.push(entry);
    }
  }

  return {
    ...nameDictionaries,
    denyList,
    denyListMeta,
    cities,
    citiesByCountry,
  };
};
