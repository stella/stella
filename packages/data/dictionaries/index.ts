/**
 * Dictionary catalog, loader, and metadata for the
 * deny list system. Dictionaries are loaded lazily
 * via dynamic imports and cached after first load.
 */

import type { CityCountryCode } from "./city-loaders";
import { CITY_LOADERS } from "./city-loaders";

export type DenyListCategory =
  | "Names"
  | "Places"
  | "Addresses"
  | "Courts"
  | "Financial"
  | "Government"
  | "Healthcare"
  | "Education"
  | "Political"
  | "Organizations"
  | "International";

export type DictionaryMeta = {
  label: string;
  category: DenyListCategory;
  country: string | null;
};

export const DICTIONARY_META = {
  // ── Names ──────────────────────────────────────────
  // Global mixed-gender name list (195K, fallback).
  "names/global": {
    label: "person",
    category: "Names",
    country: null,
  },
  // Per-language first names (Wikidata CC0).
  "names/first/cs": {
    label: "person",
    category: "Names",
    country: "CZ",
  },
  "names/first/sk": {
    label: "person",
    category: "Names",
    country: "SK",
  },
  "names/first/de": {
    label: "person",
    category: "Names",
    country: "DE",
  },
  "names/first/pl": {
    label: "person",
    category: "Names",
    country: "PL",
  },
  "names/first/hu": {
    label: "person",
    category: "Names",
    country: "HU",
  },
  "names/first/ro": {
    label: "person",
    category: "Names",
    country: "RO",
  },
  "names/first/fr": {
    label: "person",
    category: "Names",
    country: "FR",
  },
  "names/first/es": {
    label: "person",
    category: "Names",
    country: "ES",
  },
  "names/first/it": {
    label: "person",
    category: "Names",
    country: "IT",
  },
  "names/first/en": {
    label: "person",
    category: "Names",
    country: "GB",
  },
  "names/first/sv": {
    label: "person",
    category: "Names",
    country: "SE",
  },
  // Per-language surnames (Wikidata CC0).
  "names/surnames/cs": {
    label: "person",
    category: "Names",
    country: "CZ",
  },
  "names/surnames/sk": {
    label: "person",
    category: "Names",
    country: "SK",
  },
  "names/surnames/de": {
    label: "person",
    category: "Names",
    country: "DE",
  },
  "names/surnames/pl": {
    label: "person",
    category: "Names",
    country: "PL",
  },
  "names/surnames/hu": {
    label: "person",
    category: "Names",
    country: "HU",
  },
  "names/surnames/ro": {
    label: "person",
    category: "Names",
    country: "RO",
  },
  "names/surnames/fr": {
    label: "person",
    category: "Names",
    country: "FR",
  },
  "names/surnames/es": {
    label: "person",
    category: "Names",
    country: "ES",
  },
  "names/surnames/it": {
    label: "person",
    category: "Names",
    country: "IT",
  },
  "names/surnames/en": {
    label: "person",
    category: "Names",
    country: "GB",
  },
  "names/surnames/sv": {
    label: "person",
    category: "Names",
    country: "SE",
  },

  // ── Countries ──────────────────────────────────────
  // Known FP overlap: France, Italia, Holland, Malta
  // are also personal names. Mitigation at matching
  // layer (span-priority, context disambiguation).
  "countries/translations": {
    label: "country",
    category: "Places",
    country: null,
  },

  // ── Cities ─────────────────────────────────────────
  // City dictionaries are loaded by country code via
  // loadCityDictionary() — not registered here.
  // See generate-cities.ts for the GeoNames pipeline
  // and city-loaders.ts for the loader map.

  // ── Courts ─────────────────────────────────────────
  "courts/AT": {
    label: "organization",
    category: "Courts",
    country: "AT",
  },
  "courts/AU": {
    label: "organization",
    category: "Courts",
    country: "AU",
  },
  "courts/BE": {
    label: "organization",
    category: "Courts",
    country: "BE",
  },
  "courts/BG": {
    label: "organization",
    category: "Courts",
    country: "BG",
  },
  "courts/BR": {
    label: "organization",
    category: "Courts",
    country: "BR",
  },
  "courts/CA": {
    label: "organization",
    category: "Courts",
    country: "CA",
  },
  "courts/CZ": {
    label: "organization",
    category: "Courts",
    country: "CZ",
  },
  "courts/DE": {
    label: "organization",
    category: "Courts",
    country: "DE",
  },
  "courts/DK": {
    label: "organization",
    category: "Courts",
    country: "DK",
  },
  "courts/ES": {
    label: "organization",
    category: "Courts",
    country: "ES",
  },
  "courts/FI": {
    label: "organization",
    category: "Courts",
    country: "FI",
  },
  "courts/FR": {
    label: "organization",
    category: "Courts",
    country: "FR",
  },
  "courts/GB": {
    label: "organization",
    category: "Courts",
    country: "GB",
  },
  "courts/HR": {
    label: "organization",
    category: "Courts",
    country: "HR",
  },
  "courts/HU": {
    label: "organization",
    category: "Courts",
    country: "HU",
  },
  "courts/IE": {
    label: "organization",
    category: "Courts",
    country: "IE",
  },
  "courts/IT": {
    label: "organization",
    category: "Courts",
    country: "IT",
  },
  "courts/NL": {
    label: "organization",
    category: "Courts",
    country: "NL",
  },
  "courts/NO": {
    label: "organization",
    category: "Courts",
    country: "NO",
  },
  "courts/PL": {
    label: "organization",
    category: "Courts",
    country: "PL",
  },
  "courts/PT": {
    label: "organization",
    category: "Courts",
    country: "PT",
  },
  "courts/RO": {
    label: "organization",
    category: "Courts",
    country: "RO",
  },
  "courts/SE": {
    label: "organization",
    category: "Courts",
    country: "SE",
  },
  "courts/SI": {
    label: "organization",
    category: "Courts",
    country: "SI",
  },
  "courts/SK": {
    label: "organization",
    category: "Courts",
    country: "SK",
  },
  "courts/US": {
    label: "organization",
    category: "Courts",
    country: "US",
  },

  // ── Banks ──────────────────────────────────────────
  "banks/AT": {
    label: "organization",
    category: "Financial",
    country: "AT",
  },
  "banks/AU": {
    label: "organization",
    category: "Financial",
    country: "AU",
  },
  "banks/BE": {
    label: "organization",
    category: "Financial",
    country: "BE",
  },
  "banks/BG": {
    label: "organization",
    category: "Financial",
    country: "BG",
  },
  "banks/BR": {
    label: "organization",
    category: "Financial",
    country: "BR",
  },
  "banks/CA": {
    label: "organization",
    category: "Financial",
    country: "CA",
  },
  "banks/CZ": {
    label: "organization",
    category: "Financial",
    country: "CZ",
  },
  "banks/DE": {
    label: "organization",
    category: "Financial",
    country: "DE",
  },
  "banks/DK": {
    label: "organization",
    category: "Financial",
    country: "DK",
  },
  "banks/ES": {
    label: "organization",
    category: "Financial",
    country: "ES",
  },
  "banks/FI": {
    label: "organization",
    category: "Financial",
    country: "FI",
  },
  "banks/FR": {
    label: "organization",
    category: "Financial",
    country: "FR",
  },
  "banks/GB": {
    label: "organization",
    category: "Financial",
    country: "GB",
  },
  "banks/HR": {
    label: "organization",
    category: "Financial",
    country: "HR",
  },
  "banks/HU": {
    label: "organization",
    category: "Financial",
    country: "HU",
  },
  "banks/IE": {
    label: "organization",
    category: "Financial",
    country: "IE",
  },
  "banks/IT": {
    label: "organization",
    category: "Financial",
    country: "IT",
  },
  "banks/NL": {
    label: "organization",
    category: "Financial",
    country: "NL",
  },
  "banks/NO": {
    label: "organization",
    category: "Financial",
    country: "NO",
  },
  "banks/PL": {
    label: "organization",
    category: "Financial",
    country: "PL",
  },
  "banks/PT": {
    label: "organization",
    category: "Financial",
    country: "PT",
  },
  "banks/RO": {
    label: "organization",
    category: "Financial",
    country: "RO",
  },
  "banks/SE": {
    label: "organization",
    category: "Financial",
    country: "SE",
  },
  "banks/SI": {
    label: "organization",
    category: "Financial",
    country: "SI",
  },
  "banks/SK": {
    label: "organization",
    category: "Financial",
    country: "SK",
  },
  "banks/US": {
    label: "organization",
    category: "Financial",
    country: "US",
  },

  // ── Insurance ──────────────────────────────────────
  "insurance/CZ": {
    label: "organization",
    category: "Financial",
    country: "CZ",
  },
  "insurance/DE": {
    label: "organization",
    category: "Financial",
    country: "DE",
  },

  // ── Education ──────────────────────────────────────
  "education/universities-AT": {
    label: "organization",
    category: "Education",
    country: "AT",
  },
  "education/universities-CZ": {
    label: "organization",
    category: "Education",
    country: "CZ",
  },
  "education/universities-DE": {
    label: "organization",
    category: "Education",
    country: "DE",
  },
  "education/universities-SK": {
    label: "organization",
    category: "Education",
    country: "SK",
  },

  // ── Government ─────────────────────────────────────
  "government/ministries-AT": {
    label: "organization",
    category: "Government",
    country: "AT",
  },
  "government/ministries-CZ": {
    label: "organization",
    category: "Government",
    country: "CZ",
  },
  "government/ministries-DE": {
    label: "organization",
    category: "Government",
    country: "DE",
  },
  "government/ministries-GB": {
    label: "organization",
    category: "Government",
    country: "GB",
  },
  "government/ministries-SK": {
    label: "organization",
    category: "Government",
    country: "SK",
  },

  // ── Healthcare ─────────────────────────────────────
  "healthcare/hospitals-CZ": {
    label: "organization",
    category: "Healthcare",
    country: "CZ",
  },
  "healthcare/hospitals-DE": {
    label: "organization",
    category: "Healthcare",
    country: "DE",
  },

  // ── International ──────────────────────────────────
  "international/eu-institutions": {
    label: "organization",
    category: "International",
    country: null,
  },
} as const satisfies Record<string, DictionaryMeta>;

export type DictionaryId = keyof typeof DICTIONARY_META;

type JsonModule = { default: readonly string[] };

// SAFETY: dynamic import() of JSON modules returns
// { default: T } in Bun. The cast is required because
// TS infers a wider type for dynamic imports.
const LOADERS: Record<DictionaryId, () => Promise<JsonModule>> = {
  // ── Names ──────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/global": () => import("./names/global.json") as Promise<JsonModule>,
  // ── First names (Wikidata CC0) ──────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/cs": () =>
    import("./names/first/cs.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/sk": () =>
    import("./names/first/sk.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/de": () =>
    import("./names/first/de.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/pl": () =>
    import("./names/first/pl.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/hu": () =>
    import("./names/first/hu.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/ro": () =>
    import("./names/first/ro.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/fr": () =>
    import("./names/first/fr.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/es": () =>
    import("./names/first/es.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/it": () =>
    import("./names/first/it.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/en": () =>
    import("./names/first/en.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/first/sv": () =>
    import("./names/first/sv.json") as Promise<JsonModule>,
  // ── Surnames (Wikidata CC0) ─────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/cs": () =>
    import("./names/surnames/cs.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/sk": () =>
    import("./names/surnames/sk.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/de": () =>
    import("./names/surnames/de.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/pl": () =>
    import("./names/surnames/pl.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/hu": () =>
    import("./names/surnames/hu.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/ro": () =>
    import("./names/surnames/ro.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/fr": () =>
    import("./names/surnames/fr.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/es": () =>
    import("./names/surnames/es.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/it": () =>
    import("./names/surnames/it.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/en": () =>
    import("./names/surnames/en.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/surnames/sv": () =>
    import("./names/surnames/sv.json") as Promise<JsonModule>,

  // ── Countries ──────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "countries/translations": () =>
    import("./countries/translations.json") as Promise<JsonModule>,

  // ── Cities: loaded dynamically via loadCityDictionary()

  // ── Courts ─────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/AT": () => import("./courts/AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/AU": () => import("./courts/AU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/BE": () => import("./courts/BE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/BG": () => import("./courts/BG.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/BR": () => import("./courts/BR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/CA": () => import("./courts/CA.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/CZ": () => import("./courts/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/DE": () => import("./courts/DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/DK": () => import("./courts/DK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/ES": () => import("./courts/ES.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/FI": () => import("./courts/FI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/FR": () => import("./courts/FR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/GB": () => import("./courts/GB.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/HR": () => import("./courts/HR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/HU": () => import("./courts/HU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/IE": () => import("./courts/IE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/IT": () => import("./courts/IT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/NL": () => import("./courts/NL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/NO": () => import("./courts/NO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/PL": () => import("./courts/PL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/PT": () => import("./courts/PT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/RO": () => import("./courts/RO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/SE": () => import("./courts/SE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/SI": () => import("./courts/SI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/SK": () => import("./courts/SK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/US": () => import("./courts/US.json") as Promise<JsonModule>,

  // ── Banks ──────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/AT": () => import("./banks/AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/AU": () => import("./banks/AU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/BE": () => import("./banks/BE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/BG": () => import("./banks/BG.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/BR": () => import("./banks/BR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/CA": () => import("./banks/CA.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/CZ": () => import("./banks/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/DE": () => import("./banks/DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/DK": () => import("./banks/DK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/ES": () => import("./banks/ES.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/FI": () => import("./banks/FI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/FR": () => import("./banks/FR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/GB": () => import("./banks/GB.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/HR": () => import("./banks/HR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/HU": () => import("./banks/HU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/IE": () => import("./banks/IE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/IT": () => import("./banks/IT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/NL": () => import("./banks/NL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/NO": () => import("./banks/NO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/PL": () => import("./banks/PL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/PT": () => import("./banks/PT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/RO": () => import("./banks/RO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/SE": () => import("./banks/SE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/SI": () => import("./banks/SI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/SK": () => import("./banks/SK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/US": () => import("./banks/US.json") as Promise<JsonModule>,

  // ── Insurance ──────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "insurance/CZ": () => import("./insurance/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "insurance/DE": () => import("./insurance/DE.json") as Promise<JsonModule>,

  // ── Education ──────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-AT": () =>
    import("./education/universities-AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-CZ": () =>
    import("./education/universities-CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-DE": () =>
    import("./education/universities-DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-SK": () =>
    import("./education/universities-SK.json") as Promise<JsonModule>,

  // ── Government ─────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-AT": () =>
    import("./government/ministries-AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-CZ": () =>
    import("./government/ministries-CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-DE": () =>
    import("./government/ministries-DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-GB": () =>
    import("./government/ministries-GB.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-SK": () =>
    import("./government/ministries-SK.json") as Promise<JsonModule>,

  // ── Healthcare ─────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "healthcare/hospitals-CZ": () =>
    import("./healthcare/hospitals-CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "healthcare/hospitals-DE": () =>
    import("./healthcare/hospitals-DE.json") as Promise<JsonModule>,

  // ── International ──────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "international/eu-institutions": () =>
    import("./international/eu-institutions.json") as Promise<JsonModule>,
};

const cache = new Map<DictionaryId, readonly string[]>();

/**
 * Load a single dictionary by ID. Results are cached
 * after the first load.
 */
export const loadDictionary = async (
  id: DictionaryId,
): Promise<readonly string[]> => {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  const loader = LOADERS[id];
  const mod = await loader();
  const entries = mod.default;
  cache.set(id, entries);
  return entries;
};

/**
 * Load multiple dictionaries and merge into a flat
 * array of terms.
 */
export const loadDictionaries = async (
  ...ids: DictionaryId[]
): Promise<readonly string[]> => {
  const results = await Promise.all(ids.map(loadDictionary));
  const merged: string[] = [];
  for (const entries of results) {
    for (const entry of entries) {
      merged.push(entry);
    }
  }
  return merged;
};

/**
 * Load multiple dictionaries and return a deduplicated
 * Set of terms.
 */
export const loadDictionarySet = async (
  ...ids: DictionaryId[]
): Promise<ReadonlySet<string>> => {
  const results = await Promise.all(ids.map(loadDictionary));
  const set = new Set<string>();
  for (const entries of results) {
    for (const entry of entries) {
      set.add(entry);
    }
  }
  return set;
};

/** Clear the dictionary cache (for tests). */
export const clearDictionaryCache = (): void => {
  cache.clear();
};

/** All dictionary IDs, derived from metadata keys. */
export const ALL_DICTIONARY_IDS: readonly DictionaryId[] = Object.keys(
  DICTIONARY_META,
).filter((k): k is DictionaryId => k in DICTIONARY_META);

// ── City dictionaries (by country code) ───────────
//
// City dictionaries come from GeoNames (CC BY 4.0,
// pop > 5,000). They are keyed by country code in
// CITY_LOADERS rather than registered in
// DICTIONARY_META, because the number of countries
// would bloat the static type system.

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

// ── Name dictionaries (first + surnames by language) ─

export const NAME_LANGUAGES = [
  "cs",
  "sk",
  "de",
  "pl",
  "hu",
  "ro",
  "fr",
  "es",
  "it",
  "en",
  "sv",
] as const;

export type NameLanguage = (typeof NAME_LANGUAGES)[number];

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

/**
 * Load first-name and surname dictionaries for the
 * requested languages. Returns the shape expected by
 * `PipelineConfig.dictionaries`.
 *
 * Results are cached per-language; repeated calls with
 * the same languages are essentially free.
 */
export const loadNameDictionaries = async (
  languages: readonly NameLanguage[] = NAME_LANGUAGES,
): Promise<{
  firstNames: Record<string, readonly string[]>;
  surnames: Record<string, readonly string[]>;
}> => {
  const firstNames: Record<string, readonly string[]> = {};
  const surnames: Record<string, readonly string[]> = {};

  await Promise.all(
    languages.map(async (lang) => {
      const firstId = `names/first/${lang}` as DictionaryId;
      const surnameId = `names/surnames/${lang}` as DictionaryId;
      if (firstId in LOADERS) {
        firstNames[lang] = await loadDictionary(firstId);
      }
      if (surnameId in LOADERS) {
        surnames[lang] = await loadDictionary(surnameId);
      }
    }),
  );

  return { firstNames, surnames };
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
