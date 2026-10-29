import { Result } from "better-result";

import {
  isPublicCaseLawCountry,
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import type {
  CaseLawBrowserCountry,
  PublicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import type { UiLocale } from "@stll/locales";
import { normalizeUnicode } from "@stll/text-normalize";

import { caseLawCountryRegion } from "@/features/case-law/case-law-jurisdiction";
import type { useFormatter } from "@/i18n/formatting-context";

/**
 * A corpus country as a reader names it ("Czechia"). One helper, because the
 * search box, the top-bar menu, the home and the chat's Sources all have to
 * say the same country the same way. A light module, so the app shell can
 * name a country without loading the case-law screens.
 */
export const caseLawCountryName = (
  format: ReturnType<typeof useFormatter>,
  code: string,
): string => {
  const region = caseLawCountryRegion(code);
  return region === null
    ? code
    : format.displayName(region, { type: "region" });
};

const DEFAULT_COUNTRY_BY_LOCALE = {
  ar: null,
  cs: "CZE",
  de: null,
  en: null,
  es: null,
  et: null,
  fr: null,
  hu: "HUN",
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

/** What a search hit is matched against a typed reference by. */
type DecisionRefCandidate = {
  caseNumber: string;
  ecli: string | null;
};

export const decodeCaseLawDecisionRef = (value: string): string =>
  Result.try(() => decodeURIComponent(value))
    .unwrapOr(value)
    .trim();

const normalizeDecisionRef = (value: string): string =>
  normalizeUnicode(value, "NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export const pickCaseLawDecisionHit = <THit extends DecisionRefCandidate>(
  decisionRef: string,
  hits: readonly THit[],
): THit | null => {
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
