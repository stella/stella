import { Result } from "better-result";

import {
  isPublicCaseLawCountry,
  publicCaseLawCountry,
  PUBLIC_CASE_LAW_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";
import type {
  CaseLawBrowserCountry,
  PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import type { UiLocale } from "@stll/locales";

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
} as const satisfies Record<UiLocale, CaseLawBrowserCountry | null>;

/** Pick a launch-ready public country from the UI locale, then list order. */
export const defaultCaseLawCountryForLocale = (
  locale: UiLocale,
): PublicCaseLawCountry | null => {
  const localeCountry = DEFAULT_COUNTRY_BY_LOCALE[locale];
  return localeCountry !== null && isPublicCaseLawCountry(localeCountry)
    ? localeCountry
    : (PUBLIC_CASE_LAW_COUNTRIES.at(0) ?? null);
};

type ResolveCaseLawRouteCountryOptions = {
  country: string | undefined;
  locale: UiLocale;
};

/** Default an absent country, but reject an explicitly unpublished one. */
export const resolveCaseLawRouteCountry = ({
  country,
  locale,
}: ResolveCaseLawRouteCountryOptions): PublicCaseLawCountry | null =>
  country === undefined
    ? defaultCaseLawCountryForLocale(locale)
    : publicCaseLawCountry(country);

export type CaseLawDecisionSearchHit = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  decisionId: string;
  ecli: string | null;
  language?: string | null;
  languageAlternates?: readonly unknown[] | null;
  slug?: string | null;
};

export const decodeCaseLawDecisionRef = (value: string): string =>
  Result.try(() => decodeURIComponent(value))
    .unwrapOr(value)
    .trim();

const normalizeDecisionRef = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export const pickCaseLawDecisionHit = (
  decisionRef: string,
  hits: readonly CaseLawDecisionSearchHit[],
): CaseLawDecisionSearchHit | null => {
  const normalizedRef = normalizeDecisionRef(decisionRef);
  const exactCaseNumber = hits.find(
    (hit) => normalizeDecisionRef(hit.caseNumber) === normalizedRef,
  );

  if (exactCaseNumber) {
    return exactCaseNumber;
  }

  const exactEcli = hits.find(
    (hit) =>
      hit.ecli !== null && normalizeDecisionRef(hit.ecli) === normalizedRef,
  );

  return exactEcli ?? hits.at(0) ?? null;
};
