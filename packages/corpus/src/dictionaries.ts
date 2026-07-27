import type { Dictionaries, DictionaryMeta } from "@stll/anonymize";
import {
  ALL_DICTIONARY_IDS,
  DICTIONARY_META,
  loadDictionary,
  loadNameDictionaries,
} from "@stll/anonymize-data";
import { loadCityDictionary } from "@stll/anonymize-data/cities";

/** Countries with bundled city dictionaries (mirrors the CLI default). */
const CITY_COUNTRIES = [
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

/**
 * Load every bundled dictionary, unscoped. Corpus runs
 * favor recall and reproducibility over startup time.
 */
export const loadCorpusDictionaries = async (): Promise<Dictionaries> => {
  const [names, denyEntries, cityEntries] = await Promise.all([
    loadNameDictionaries(),
    Promise.all(
      ALL_DICTIONARY_IDS.map(async (id) => ({
        id,
        entries: await loadDictionary(id),
      })),
    ),
    Promise.all(
      CITY_COUNTRIES.map(async (country) => ({
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
    if (entries.length > 0) {
      citiesByCountry[country] = entries;
    }
  }

  return {
    firstNames: names.firstNames,
    surnames: names.surnames,
    denyList,
    denyListMeta,
    citiesByCountry,
  };
};
