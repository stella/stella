import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

const DEFAULT_PAGE_SIZE = 50;

export const caseLawDecisionKeys = {
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
  search?: string;
  sourceId?: string;
};

export type FacetBucket = { value: string; count: number };

export type SearchFacets = {
  court: FacetBucket[];
  country: FacetBucket[];
} | null;

export const decisionsInfiniteOptions = (filters: DecisionListFilters = {}) =>
  infiniteQueryOptions({
    queryKey: caseLawDecisionKeys.list(filters),
    queryFn: async ({ pageParam, signal }) => {
      const { search, ...listFilters } = filters;

      if (search) {
        const response = await api["case-law"].decisions.search.post(
          {
            query: search,
            limit: DEFAULT_PAGE_SIZE,
            cursor: pageParam ?? undefined,
            ...listFilters,
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
            decisionDate: h.decisionDate,
            decisionType: h.decisionType,
            sourceUrl: h.sourceUrl,
            headline: h.headline,
            createdAt: new Date(h.createdAt),
          })),
          // SAFETY: Eden infers a compatible shape but TS can't
          // unify it with our hand-defined SearchFacets type.
          facets: response.data.facets as SearchFacets,
          nextCursor: response.data.nextCursor,
        };
      }

      const response = await api["case-law"].decisions.get({
        query: {
          limit: DEFAULT_PAGE_SIZE,
          cursor: pageParam ?? undefined,
          ...listFilters,
        },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      // SAFETY: List branch has no facets; null is a valid
      // SearchFacets value.
      return { ...response.data, facets: null as SearchFacets };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

export const decisionOptions = (decisionId: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.byId(decisionId),
    queryFn: async ({ signal }) => {
      const response = await api["case-law"]
        .decisions({ decisionId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
