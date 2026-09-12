import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { PublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { SEARCH_TOTAL_NOT_COUNTED } from "@stll/api-contract/search";

import type { DecisionSortOrder } from "@/features/case-law/case-law-index-search.logic";
import { api } from "@/lib/api";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const DEFAULT_PAGE_SIZE = 50;

export type DecisionListFilters = {
  court?: string;
  country: string;
  dateFrom?: string;
  dateTo?: string;
  decisionType?: string;
  language?: string;
  search?: string;
  /** How a search orders its hits; absent while there is nothing to rank. */
  sort?: DecisionSortOrder;
  sourceId?: string;
};

const caseLawDecisionKeys = {
  all: ["case-law-decisions"],
  facets: (country: string | undefined) => [
    ...caseLawDecisionKeys.all,
    "facets",
    { country },
  ],
  latest: (country: string) => [
    ...caseLawDecisionKeys.all,
    "latest",
    { country },
  ],
  status: (country: string) => [
    ...caseLawDecisionKeys.all,
    "status",
    { country },
  ],
  list: (key: DecisionListFilters) => [
    ...caseLawDecisionKeys.all,
    "list",
    {
      court: key.court,
      country: key.country,
      dateFrom: key.dateFrom,
      dateTo: key.dateTo,
      decisionType: key.decisionType,
      language: key.language,
      search: key.search,
      sort: key.sort,
      sourceId: key.sourceId,
    },
  ],
  byId: (decisionId: string) => [...caseLawDecisionKeys.all, decisionId],
  bySlug: (key: DecisionBySlugKey) => [
    ...caseLawDecisionKeys.all,
    "slug",
    { country: key.country, language: key.language, slug: key.slug },
  ],
};

type DecisionBySlugKey = {
  country: PublicCaseLawCountry;
  language?: string;
  slug: string;
};

type FacetBucket = { value: string; count: number };

/**
 * The facets of one result set, as the search endpoint reports them on the
 * first page. Null on a cursor page: counting again per page would cost a
 * second pass over the same hits for an answer the rail already has.
 */
export type SearchFacets = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof decisionsInfiniteOptions>["queryFn"]>
    >
  >["facets"]
>;

export type CaseLawBrowseFacets = {
  country: FacetBucket[];
  court: FacetBucket[];
  year: FacetBucket[];
};

/** Facets of the whole corpus, or of one jurisdiction when `country` is given. */
export const decisionFacetsOptions = (country: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.facets(country),
    queryFn: async ({ signal }): Promise<CaseLawBrowseFacets> => {
      const response = await api.case.decisions.facets.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(response, "listPublicCaseLawFacets");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** The newest decisions of a jurisdiction's largest courts: the browse page's shelf. */
export const latestDecisionsOptions = (country: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.latest(country),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions.latest.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(
        response,
        "listLatestPublicCaseLawDecisions",
      );

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** How much case law the database holds and when it last changed. */
export const caseLawCorpusStatusOptions = (country: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.status(country),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions.status.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(
        response,
        "readPublicCaseLawCorpusStatus",
      );

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** One apex court's slice of the shelf: the court, its rank, its newest few. */
export type LatestDecisionsCourt = Awaited<
  ReturnType<NonNullable<ReturnType<typeof latestDecisionsOptions>["queryFn"]>>
>["courts"][number];

export const decisionsInfiniteOptions = (filters: DecisionListFilters) =>
  infiniteQueryOptions({
    queryKey: caseLawDecisionKeys.list(filters),
    queryFn: async ({ pageParam, signal }) => {
      const { search, ...listFilters } = filters;

      if (search) {
        const cursor = pageParam ?? undefined;
        const response = await api.case.decisions.search.post(
          {
            query: search,
            limit: DEFAULT_PAGE_SIZE,
            ...(cursor !== undefined && { cursor }),
            ...(listFilters.court !== undefined && {
              court: listFilters.court,
            }),
            country: listFilters.country,
            ...(listFilters.dateFrom !== undefined && {
              dateFrom: listFilters.dateFrom,
            }),
            ...(listFilters.dateTo !== undefined && {
              dateTo: listFilters.dateTo,
            }),
            ...(listFilters.decisionType !== undefined && {
              decisionType: listFilters.decisionType,
            }),
            ...(listFilters.language !== undefined && {
              language: listFilters.language,
            }),
            ...(listFilters.sourceId !== undefined && {
              sourceId: toSafeId<"caseLawSource">(listFilters.sourceId),
            }),
            ...(listFilters.sort !== undefined && { sort: listFilters.sort }),
          },
          { fetch: { signal } },
        );

        const data = unwrapPublicLawEden(
          response,
          "searchPublicCaseLawDecisions",
        );

        return {
          decisions: data.hits.map((h) => ({
            id: toSafeId<"caseLawDecision">(h.decisionId),
            caseNumber: h.caseNumber,
            slug: h.slug,
            ecli: h.ecli,
            identifiers: h.identifiers,
            court: h.court,
            country: h.country,
            language: h.language,
            languageAlternates: h.languageAlternates,
            decisionDate: h.decisionDate,
            decisionType: h.decisionType,
            sourceUrl: h.sourceUrl,
            headnote: h.headnote,
            headline: h.headline,
            anchorId: h.anchorId,
            citationCount: h.citationCount,
            createdAt:
              parseDeterministicDate(h.createdAt) ??
              panic("Public case-law API returned an invalid createdAt"),
          })),
          facets: data.facets,
          nextCursor: data.nextCursor,
          total: data.total,
        };
      }

      const response = await api.case.decisions.get({
        query: {
          limit: DEFAULT_PAGE_SIZE,
          ...(pageParam !== null && { cursor: pageParam }),
          ...(listFilters.court !== undefined && {
            court: listFilters.court,
          }),
          country: listFilters.country,
          ...(listFilters.dateFrom !== undefined && {
            dateFrom: listFilters.dateFrom,
          }),
          ...(listFilters.dateTo !== undefined && {
            dateTo: listFilters.dateTo,
          }),
          ...(listFilters.decisionType !== undefined && {
            decisionType: listFilters.decisionType,
          }),
          ...(listFilters.language !== undefined && {
            language: listFilters.language,
          }),
          ...(listFilters.sourceId !== undefined && {
            sourceId: toSafeId<"caseLawSource">(listFilters.sourceId),
          }),
        },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(response, "listPublicCaseLawDecisions");

      const facets = null;
      const { items, ...page } = data;
      return {
        ...page,
        decisions: items,
        facets,
        total: SEARCH_TOTAL_NOT_COUNTED,
      };
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const decisionOptions = (decisionId: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.byId(decisionId),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
        .get({ fetch: { signal } });

      const data = unwrapPublicLawEden(response, "readPublicCaseLawDecision");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const decisionBySlugOptions = ({
  country,
  language,
  slug,
}: DecisionBySlugKey) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.bySlug(
      language === undefined ? { country, slug } : { country, language, slug },
    ),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions["by-slug"]({ slug }).get({
        query: {
          country,
          ...(language !== undefined && { language }),
        },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(
        response,
        "readPublicCaseLawDecisionBySlug",
      );

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
