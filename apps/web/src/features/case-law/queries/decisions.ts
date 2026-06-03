import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

const DEFAULT_PAGE_SIZE = 50;

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

const caseLawDecisionKeys = {
  all: ["case-law-decisions"],
  facets: () => [...caseLawDecisionKeys.all, "facets"],
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
      sourceId: key.sourceId,
    },
  ],
  byId: (decisionId: string) => [...caseLawDecisionKeys.all, decisionId],
  bySlug: (slug: string) => [...caseLawDecisionKeys.all, "slug", slug],
};

type FacetBucket = { value: string; count: number };

export type SearchFacets = {
  court: FacetBucket[];
  country: FacetBucket[];
  language: FacetBucket[];
} | null;

export type CaseLawBrowseFacets = {
  country: FacetBucket[];
  court: FacetBucket[];
  year: FacetBucket[];
};

export const decisionFacetsOptions = () =>
  queryOptions({
    queryKey: caseLawDecisionKeys.facets(),
    queryFn: async ({ signal }): Promise<CaseLawBrowseFacets> => {
      const response = await api.case.decisions.facets.get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const decisionsInfiniteOptions = (filters: DecisionListFilters = {}) =>
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
              sourceId: toSafeId<"caseLawSource">(listFilters.sourceId),
            }),
          },
          { fetch: { signal } },
        );

        if (response.error) {
          throw toAPIError(response.error);
        }
        return {
          decisions: response.data.hits.map((h) => ({
            id: toSafeId<"caseLawDecision">(h.decisionId),
            caseNumber: h.caseNumber,
            slug: h.slug,
            ecli: h.ecli,
            court: h.court,
            country: h.country,
            language: h.language,
            // Search endpoint doesn't return languageGroupKey;
            // language grouping is only available via the list endpoint.
            languageAlternateCount: 0,
            languageGroupKey: null,
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

      const response = await api.case.decisions.get({
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
            sourceId: toSafeId<"caseLawSource">(listFilters.sourceId),
          }),
        },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      const facets: SearchFacets = null;
      const { items, ...page } = response.data;
      return { ...page, decisions: items, facets };
    },
    // SAFETY: TanStack Query needs the initial param typed as
    // string | null; `null` alone infers `null`.
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

export const decisionOptions = (decisionId: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.byId(decisionId),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const decisionBySlugOptions = (slug: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.bySlug(slug),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions["by-slug"]({ slug }).get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
