import { COUNTRY_CODES, isCountryCode } from "@stll/country-codes";
import type { CountryCode } from "@stll/country-codes";
import { stripUnicodeMarks } from "@stll/text-normalize";

import type { Country } from "./entry";

// Official long forms the UN and Czech lists use that CLDR display names do
// not spell out. Keys are in `countryKey` form.
const OFFICIAL_NAMES: Readonly<Record<string, CountryCode>> = {
  "bosnia and herzegovina": "BA",
  "ceska republika": "CZ",
  china: "CN",
  "china hong kong special administrative region": "HK",
  congo: "CG",
  "democratic people s republic of korea": "KP",
  "democratic republic of the congo": "CD",
  "iran islamic republic of": "IR",
  "libanonska republika": "LB",
  myanmar: "MM",
  "ruska federace": "RU",
  "russian federation": "RU",
  "state of palestine": "PS",
  "syrian arab republic": "SY",
  "trinidad and tobago": "TT",
  turkey: "TR",
  "united kingdom of great britain and northern ireland": "GB",
  "united republic of tanzania": "TZ",
  "united states of america": "US",
  "viet nam": "VN",
};

const countryKey = (name: string): string =>
  stripUnicodeMarks(name, { form: "NFD", markClass: "combining" })
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

let codesByName: ReadonlyMap<string, CountryCode> | null = null;

const getCodesByName = (): ReadonlyMap<string, CountryCode> => {
  if (codesByName !== null) {
    return codesByName;
  }
  const map = new Map<string, CountryCode>();
  for (const locale of ["en", "cs"]) {
    const displayNames = new Intl.DisplayNames([locale], { type: "region" });
    for (const code of COUNTRY_CODES) {
      const name = displayNames.of(code);
      if (name !== undefined) {
        map.set(countryKey(name), code);
      }
    }
  }
  for (const [name, code] of Object.entries(OFFICIAL_NAMES)) {
    map.set(name, code);
  }
  codesByName = map;
  return map;
};

/** Resolves a country name as a list spells it; unknown names keep a null code. */
export const countryFromName = (name: string): Country => ({
  code: getCodesByName().get(countryKey(name)) ?? null,
  name,
});

/** EU rows carry ISO codes directly and use "00" for an unknown country. */
export const countryFromIso = (code: string | null, name: string): Country => ({
  code: code !== null && isCountryCode(code) ? code : null,
  name,
});
