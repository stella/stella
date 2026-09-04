import { type CountryCode, isCountryCode } from "@stll/country-codes";

import { compareByLocale } from "@stll/collation";
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

type DisplayNameFormatter = (
  value: string,
  options: Intl.DisplayNamesOptions,
) => string | undefined;

export const createCountryOptions = (
  locale: string,
  formatDisplayName: DisplayNameFormatter,
): CountryOption[] => {
  const compareName = compareByLocale(locale);

  return COUNTRY_CODES.map((code) => ({
    code,
    name: countryName(code, formatDisplayName),
  })).sort((a, b) => compareName(a.name, b.name));
};

export const countryName = (
  countryCode: CountryCode,
  formatDisplayName: DisplayNameFormatter,
): string => formatDisplayName(countryCode, { type: "region" }) ?? countryCode;

export const suggestedCountryCodes = ({
  email,
  browserRegion,
  detectedCountry,
}: {
  email: string;
  /** Region subtag detected from the browser's own locale preferences. */
  browserRegion?: string | undefined;
  /**
   * Country recorded server-side at signup from the edge's geo header.
   * Ranked above the locale and email heuristics because it reflects
   * where the person actually registered from.
   */
  detectedCountry?: string | null | undefined;
}): CountryCode[] => {
  const suggestions: string[] = [];
  const emailTld = email.split(".").at(-1)?.toLowerCase();

  if (detectedCountry) {
    suggestions.push(detectedCountry.toUpperCase());
  }

  if (browserRegion) {
    suggestions.push(browserRegion.toUpperCase());
  }

  const countryCodeFromEmail = countryCodeFromEmailTld(emailTld);

  if (countryCodeFromEmail) {
    suggestions.push(countryCodeFromEmail);
  }

  return Array.from(new Set(suggestions.filter(isCountryCode)));
};
