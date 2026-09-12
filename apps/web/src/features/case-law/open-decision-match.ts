import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";

import { decisionDocketGrammarForJurisdiction } from "@stll/api-contract/decision-docket-grammar";
import {
  type DecisionQueryIntent,
  exactDecisionMatches,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";

import {
  decisionDateRange,
  decisionSortOrder,
} from "@/features/case-law/case-law-index-search.logic";
import type { CaseLawIndexSearch } from "@/features/case-law/case-law-index-search.logic";
import { fromCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import {
  decisionsInfiniteOptions,
  type DecisionListFilters,
} from "@/features/case-law/queries/decisions";
import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";

/** What a case-law URL says about the corpus slice the reader is looking at. */
export type CaseLawSearchScope = CaseLawIndexSearch;

/**
 * The corpus country the pill names. A URL without a country is scoped by
 * `beforeLoad` before public search calls this helper.
 */
export const caseLawCountryScope = (
  country: string | undefined,
): string | undefined =>
  country === undefined ? undefined : fromCaseLawCountryParam(country);

type ReadDecisionIntentOptions = {
  readonly jurisdiction?: string | undefined;
};

export const readDecisionIntent = (
  q: string | undefined,
  { jurisdiction }: ReadDecisionIntentOptions = {},
): DecisionQueryIntent => {
  if (q === undefined) {
    return { type: "empty" };
  }
  const grammar =
    jurisdiction === undefined
      ? undefined
      : decisionDocketGrammarForJurisdiction(jurisdiction);
  return parseDecisionQuery(q, { grammar });
};

/** The text a query intent hands the search endpoint, if any. */
const searchTextOfIntent = (
  intent: DecisionQueryIntent,
): string | undefined => {
  switch (intent.type) {
    case "identifier":
      return intent.value;
    case "text":
      return intent.text;
    case "empty":
      return undefined;
    default:
      intent satisfies never;
      return panic("Unhandled decision query intent");
  }
};

export const createDecisionFiltersFromSearch = ({
  country,
  court,
  from,
  lang,
  q,
  sort,
  source,
  to,
  type,
  year,
}: CaseLawSearchScope): DecisionListFilters => {
  const scope = caseLawCountryScope(country);
  if (scope === undefined) {
    return panic("Case-law search requires a country.");
  }
  const range = decisionDateRange({ from, to, year });
  const search = searchTextOfIntent(
    readDecisionIntent(q, { jurisdiction: scope }),
  );

  return {
    country: scope,
    ...(court ? { court } : {}),
    ...(range.from === undefined ? {} : { dateFrom: range.from }),
    ...(range.to === undefined ? {} : { dateTo: range.to }),
    ...(type ? { decisionType: type } : {}),
    ...(source ? { sourceId: source } : {}),
    ...(lang ? { language: lang } : {}),
    // An order is a property of a ranked answer, so a browse listing carries
    // none: it is newest-first by definition.
    ...(search === undefined ? {} : { search, sort: decisionSortOrder(sort) }),
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
  const intent = readDecisionIntent(search.q, {
    jurisdiction: caseLawCountryScope(search.country),
  });
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
