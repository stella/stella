import { type CountryCode, isCountryCode } from "@stll/country-codes";

import { compareByLocale } from "@/lib/collation";
import { COUNTRY_CENTROIDS, COUNTRY_CODES } from "@/lib/country-centroids";

export { COUNTRY_CODES };
export type { CountryCode };

export type PracticeJurisdiction = {
  countryCode: CountryCode;
  isPrimary: boolean;
};

export const removeJurisdiction = (
  selected: readonly PracticeJurisdiction[],
  countryCode: CountryCode,
): PracticeJurisdiction[] => {
  const remaining = selected.filter(
    (jurisdiction) => jurisdiction.countryCode !== countryCode,
  );

  if (remaining.length === 0) {
    return [];
  }

  if (remaining.some((jurisdiction) => jurisdiction.isPrimary)) {
    return [...remaining];
  }

  const first = remaining.at(0);
  if (!first) {
    return [];
  }

  return [{ ...first, isPrimary: true }, ...remaining.slice(1)];
};

export type CountryOption = {
  code: CountryCode;
  name: string;
};

export type CountryPoint = {
  code: CountryCode;
  lat: number;
  lon: number;
};

export const COUNTRY_POINTS: readonly CountryPoint[] = COUNTRY_CODES.map(
  (code) => {
    const [lat, lon] = COUNTRY_CENTROIDS[code];
    return { code, lat, lon };
  },
);

const LOCALE_REGION_PATTERN = /[-_](?<region>[A-Za-z]{2})\b/u;

const countryCodeFromEmailTld = (
  emailTld: string | undefined,
): CountryCode | undefined => {
  if (emailTld === undefined) {
    return undefined;
  }
  if (emailTld === "uk") {
    return "GB";
  }
  return COUNTRY_CODES.find((code) => code.toLowerCase() === emailTld);
};

// Region names only vary by locale; cache one Intl.DisplayNames instance per
// locale instead of rebuilding it on every call.
const regionDisplayNamesByLocale = new Map<string, Intl.DisplayNames>();
const getRegionDisplayNames = (locale: string): Intl.DisplayNames => {
  let displayNames = regionDisplayNamesByLocale.get(locale);
  if (!displayNames) {
    displayNames = new Intl.DisplayNames([locale], { type: "region" });
    regionDisplayNamesByLocale.set(locale, displayNames);
  }
  return displayNames;
};

export const createCountryOptions = (locale: string): CountryOption[] => {
  const names = getRegionDisplayNames(locale);
  const compareName = compareByLocale(locale);

  return COUNTRY_CODES.map((code) => ({
    code,
    name: names.of(code) ?? code,
  })).sort((a, b) => compareName(a.name, b.name));
};

export const countryName = (
  countryCode: CountryCode,
  locale: string,
): string => {
  const names = getRegionDisplayNames(locale);

  return names.of(countryCode) ?? countryCode;
};

export const suggestedCountryCodes = ({
  email,
  locale,
}: {
  email: string;
  locale: string;
}): CountryCode[] => {
  const suggestions: string[] = [];
  const regionFromLocale =
    LOCALE_REGION_PATTERN.exec(locale)?.groups?.["region"];
  const emailTld = email.split(".").at(-1)?.toLowerCase();

  if (regionFromLocale) {
    suggestions.push(regionFromLocale.toUpperCase());
  }

  const countryCodeFromEmail = countryCodeFromEmailTld(emailTld);

  if (countryCodeFromEmail) {
    suggestions.push(countryCodeFromEmail);
  }

  return Array.from(new Set(suggestions.filter(isCountryCode)));
};
