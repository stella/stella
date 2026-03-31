import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

const DEFAULT_PAGE_SIZE = 50;

const caseLawDecisionKeys = {
  all: ["case-law-decisions"],
  list: (filters?: Record<string, unknown>) => [
    ...caseLawDecisionKeys.all,
    "list",
    filters,
  ],
  byId: (decisionId: string) => [...caseLawDecisionKeys.all, decisionId],
};

export type DecisionListFilters = {
  court?: string;
  country?: string;
  dateFrom?: string;
  dateTo?: string;
  decisionType?: string;
  language?: string;
  search?: string;
  sourceId?: string;
};

type FacetBucket = { value: string; count: number };

export type SearchFacets = {
  court: FacetBucket[];
  country: FacetBucket[];
  language: FacetBucket[];
} | null;

export const decisionsInfiniteOptions = (filters: DecisionListFilters = {}) =>
  infiniteQueryOptions({
    queryKey: caseLawDecisionKeys.list(filters),
    queryFn: async ({ pageParam, signal }) => {
      const { search, ...listFilters } = filters;

      if (search) {
        const cursor = pageParam ?? undefined;
        const response = await api["case"].decisions.search.post(
          {
            query: search,
            limit: DEFAULT_PAGE_SIZE,
            ...(cursor !== undefined && { cursor }),
            ...(listFilters.court !== undefined && {
              court: listFilters.court,
            }),
            ...(listFilters.country !== undefined && {
              country: listFilters.country,
            }),
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
              sourceId: listFilters.sourceId,
            }),
          },
          { fetch: { signal } },
        );

        if (response.error) {
          throw toAPIError(response.error);
        }
        return {
          decisions: response.data.hits.map((h) => ({
            id: h.decisionId,
            caseNumber: h.caseNumber,
            ecli: h.ecli,
            court: h.court,
            country: h.country,
            language: h.language,
            // Search endpoint doesn't return languageGroupKey;
            // language grouping is only available via the list endpoint.
            languageGroupKey: null as string | null,
            decisionDate: h.decisionDate,
            decisionType: h.decisionType,
            sourceUrl: h.sourceUrl,
            headline: h.headline,
            createdAt: new Date(h.createdAt),
          })),
          facets: response.data.facets,
          nextCursor: response.data.nextCursor,
        };
      }

      const response = await api["case"].decisions.get({
        query: {
          limit: DEFAULT_PAGE_SIZE,
          ...(pageParam !== null && { cursor: pageParam }),
          ...(listFilters.court !== undefined && {
            court: listFilters.court,
          }),
          ...(listFilters.country !== undefined && {
            country: listFilters.country,
          }),
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
            sourceId: listFilters.sourceId,
          }),
        },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      const facets: SearchFacets = null;
      return { ...response.data, facets };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

export const decisionOptions = (decisionId: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.byId(decisionId),
    queryFn: async ({ signal }) => {
      const response = await api["case"]
        .decisions({ decisionId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
