import type { Dictionaries, DictionaryMeta } from "@stll/anonymize";
import {
  ALL_DICTIONARY_IDS,
  DICTIONARY_META,
  loadDictionary,
  loadNameDictionaries,
  type NameLanguage,
} from "@stll/anonymize-data";
import { loadCityDictionary } from "@stll/anonymize-data/cities";

import { UsageError } from "./args";
import type { DictionaryScope } from "./dictionary-scope";
import {
  NAME_DICTIONARY_PREFIXES,
  nameLanguageOfDictionary,
} from "./dictionary-scope";

/**
 * Countries with bundled city dictionaries that are
 * loaded when no --countries scope is given.
 */
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

const availableNameLanguages = (): readonly string[] =>
  ALL_DICTIONARY_IDS.filter((id) =>
    id.startsWith(NAME_DICTIONARY_PREFIXES[0]),
  ).map((id) => id.slice(NAME_DICTIONARY_PREFIXES[0].length));

const validateLanguages = (
  languages: readonly string[],
): readonly NameLanguage[] => {
  const available = availableNameLanguages();
  const invalid = languages.find((lang) => !available.includes(lang));
  if (invalid) {
    throw new UsageError(
      `--languages: no name dictionary for "${invalid}"; available: ${available.join(", ")}`,
    );
  }
  // SAFETY: every entry was checked against the bundled
  // name dictionary ids, which define NameLanguage.
  return languages as readonly NameLanguage[];
};

export type LoadCliDictionariesOptions = DictionaryScope;

/**
 * Load the bundled @stll/anonymize-data dictionaries,
 * scoped to the requested languages and countries.
 */
export const loadCliDictionaries = async ({
  languages,
  countries,
}: LoadCliDictionariesOptions): Promise<Dictionaries> => {
  const nameLanguages =
    languages === undefined ? undefined : validateLanguages(languages);

  const denyIds = ALL_DICTIONARY_IDS.filter((id) => {
    const meta = DICTIONARY_META[id];
    if (
      countries &&
      meta.country !== null &&
      !countries.includes(meta.country)
    ) {
      return false;
    }
    const nameLang = nameLanguageOfDictionary(id);
    if (nameLang !== null && nameLanguages !== undefined) {
      return nameLanguages.includes(
        // SAFETY: nameLang comes from a bundled dictionary
        // id, which defines NameLanguage.
        nameLang as NameLanguage,
      );
    }
    return true;
  });

  const cityCountries = countries ?? DEFAULT_CITY_COUNTRIES;

  const [names, denyEntries, cityEntries] = await Promise.all([
    loadNameDictionaries(nameLanguages),
    Promise.all(
      denyIds.map(async (id) => ({ id, entries: await loadDictionary(id) })),
    ),
    Promise.all(
      cityCountries.map(async (country) => ({
        country,
        entries: await loadCityDictionary(country),
      })),
    ),
  ]);

  const denyList: Record<string, readonly string[]> = {};
  const denyListMeta: Record<string, DictionaryMeta> = {};
  for (const { id, entries } of denyEntries) {
    denyList[id] = entries;
    // SAFETY: anonymize-data categories match
    // DenyListCategory at runtime.
    denyListMeta[id] = DICTIONARY_META[id] as DictionaryMeta;
  }

  const citiesByCountry: Record<string, readonly string[]> = {};
  for (const { country, entries } of cityEntries) {
    if (entries.length > 0) citiesByCountry[country] = entries;
  }

  return {
    firstNames: names.firstNames,
    surnames: names.surnames,
    denyList,
    denyListMeta,
    citiesByCountry,
  };
};
