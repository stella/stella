import { type CountryCode, isCountryCode } from "@stll/country-codes";

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

const COUNTRY_CODE_BY_EMAIL_TLD = new Map<string, CountryCode>(
  COUNTRY_CODES.map((code) => [code.toLowerCase(), code]),
);
COUNTRY_CODE_BY_EMAIL_TLD.set("uk", "GB");

const LOCALE_REGION_PATTERN = /[-_]([A-Za-z]{2})\b/u;

export const createCountryOptions = (locale: string): CountryOption[] => {
  const names = new Intl.DisplayNames([locale], { type: "region" });

  return COUNTRY_CODES.map((code) => ({
    code,
    name: names.of(code) ?? code,
  })).sort((a, b) => a.name.localeCompare(b.name, locale));
};

export const countryName = (
  countryCode: CountryCode,
  locale: string,
): string => {
  const names = new Intl.DisplayNames([locale], { type: "region" });

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
  const regionFromLocale = LOCALE_REGION_PATTERN.exec(locale)?.at(1);
  const emailTld = email.split(".").at(-1)?.toLowerCase();

  if (regionFromLocale) {
    suggestions.push(regionFromLocale.toUpperCase());
  }

  const countryCodeFromEmail = emailTld
    ? COUNTRY_CODE_BY_EMAIL_TLD.get(emailTld)
    : undefined;

  if (countryCodeFromEmail) {
    suggestions.push(countryCodeFromEmail);
  }

  return Array.from(new Set(suggestions.filter(isCountryCode)));
};
