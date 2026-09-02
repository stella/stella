import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";

import {
  CASE_LAW_ALL_COUNTRIES,
  fromCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import {
  type DecisionQueryIntent,
  exactDecisionMatches,
  parseDecisionQuery,
} from "@/features/case-law/decision-query-intent";
import {
  decisionsInfiniteOptions,
  type DecisionListFilters,
} from "@/features/case-law/queries/decisions";
import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";

/** What a case-law URL says about the corpus slice the reader is looking at. */
export type CaseLawSearchScope = {
  /** The pill's value: a country param, `all`, or nothing yet. */
  country?: string | undefined;
  court?: string | undefined;
  q?: string | undefined;
  year?: string | undefined;
};

export const validDecisionYear = (
  year: string | undefined,
): string | undefined => (/^\d{4}$/u.test(year ?? "") ? year : undefined);

/**
 * The corpus country the pill names: none for `all`, else the code. A URL
 * without a country is scoped by `beforeLoad` before this is ever read.
 */
export const caseLawCountryScope = (
  country: string | undefined,
): string | undefined =>
  country === undefined || country === CASE_LAW_ALL_COUNTRIES
    ? undefined
    : fromCaseLawCountryParam(country);

export const readDecisionIntent = (
  q: string | undefined,
): DecisionQueryIntent =>
  q === undefined ? { type: "empty" } : parseDecisionQuery(q);

export const createDecisionFiltersFromSearch = ({
  country,
  court,
  q,
  year,
}: CaseLawSearchScope): DecisionListFilters => {
  const scope = caseLawCountryScope(country);
  const normalizedYear = validDecisionYear(year);
  const intent = readDecisionIntent(q);

  return {
    ...(scope === undefined ? {} : { country: scope }),
    ...(court ? { court } : {}),
    ...(normalizedYear
      ? {
          dateFrom: `${normalizedYear}-01-01`,
          dateTo: `${normalizedYear}-12-31`,
        }
      : {}),
    ...(intent.type === "identifier" ? { search: intent.value } : {}),
    ...(intent.type === "text" ? { search: intent.text } : {}),
  };
};

type OpenDecisionMatchOptions = {
  navigate: ReturnType<typeof useNavigate>;
  queryClient: QueryClient;
  search: CaseLawSearchScope;
  /** The reader's UI language, which picks between language versions. */
  uiLocale: string;
};

/**
 * Open the decision the entry names, when exactly one answers to it. Several
 * (the same docket at several courts) are left to the reader to choose
 * between, so the caller falls back to its list; the return value says which
 * happened.
 */
export const openDecisionMatch = async ({
  navigate,
  queryClient,
  search,
  uiLocale,
}: OpenDecisionMatchOptions): Promise<boolean> => {
  const intent = readDecisionIntent(search.q);
  if (intent.type !== "identifier") {
    return false;
  }

  const pages = await ensureRouteInfiniteQueryData(
    queryClient,
    decisionsInfiniteOptions(
      createDecisionFiltersFromSearch({ ...search, q: intent.value }),
    ),
  );
  // Only a result set the page has seen whole can prove the match is the only
  // one: with more pages unseen, another court's decision under the same
  // docket may still be coming, so the list stays and the reader picks.
  const firstPage = pages.pages.at(0);
  if (firstPage === undefined || firstPage.nextCursor !== null) {
    return false;
  }

  const matches = exactDecisionMatches(intent.value, firstPage.decisions);
  const only = matches.length === 1 ? matches.at(0) : undefined;
  if (only === undefined) {
    return false;
  }

  const preferred = pickPreferredCaseLawLanguageVariant({
    alternates: only.languageAlternates,
    matchedLanguage: only.language,
    uiLocale,
  });
  const target =
    preferred === null
      ? {
          caseNumber: only.caseNumber,
          country: only.country,
          court: only.court,
          decisionId: only.id,
          language: only.language,
          slug: only.slug,
        }
      : {
          caseNumber: preferred.caseNumber,
          country: preferred.country,
          court: preferred.court,
          decisionId: preferred.id,
          language: preferred.language,
          slug: preferred.slug,
        };
  const params = createCaseLawDecisionRouteParams({
    ...target,
    languageAlternates: only.languageAlternates,
  });

  await (params.language === undefined
    ? navigate({
        params: {
          country: params.country,
          court: params.court,
          slug: params.slug,
        },
        to: "/law/$country/cases/$court/$slug",
      })
    : navigate({
        params: {
          country: params.country,
          court: params.court,
          language: params.language,
          slug: params.slug,
        },
        to: "/law/$country/cases/$court/$language/$slug",
      }));

  return true;
};
