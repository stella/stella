import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { stripUndefined } from "@/lib/utils";

const DEFAULT_PAGE_SIZE = 50;

const caseLawDecisionKeys = {
  all: ["case-law-decisions"],
  list: (filters?: DecisionListFilters) => [
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
  decisionType: FacetBucket[];
  language: FacetBucket[];
} | null;

export type Decision = {
  id: string;
  authorityScore: number;
  caseNumber: string;
  citationCount: number;
  court: string;
  country: string;
  createdAt: Date | string;
  decisionDate: Date | string | null;
  decisionType: string | null;
  ecli: string | null;
  headline?: string | null;
  language: string;
  languageGroupKey?: string | null;
  negativeCitationCount: number;
  positiveCitationCount: number;
  sourceName: string | null;
  sourceUrl: string | null;
  supportiveCitationCount: number;
};

const normalizeUserSearch = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const normalizeSourceId = (
  value: string | undefined,
): ReturnType<typeof toSafeId<"caseLawSource">> | undefined =>
  value ? toSafeId<"caseLawSource">(value) : undefined;

export const decisionsInfiniteOptions = (filters: DecisionListFilters = {}) =>
  infiniteQueryOptions({
    queryKey: caseLawDecisionKeys.list(filters),
    queryFn: async ({ pageParam, signal }) => {
      const search = normalizeUserSearch(filters.search);

      if (search) {
        const request = stripUndefined({
          query: search,
          limit: DEFAULT_PAGE_SIZE,
          cursor: pageParam,
          court: filters.court,
          country: filters.country,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          decisionType: filters.decisionType,
          language: filters.language,
          sourceId: normalizeSourceId(filters.sourceId),
        });
        const response = await api.case.decisions.search.post(request, {
          fetch: { signal },
        });

        if (response.error) {
          throw toAPIError(response.error);
        }
        return {
          decisions: response.data.hits.map((h) => ({
            id: toSafeId<"caseLawDecision">(h.decisionId),
            caseNumber: h.caseNumber,
            ecli: h.ecli,
            court: h.court,
            country: h.country,
            language: h.language,
            // Search endpoint doesn't return languageGroupKey;
            // language grouping is only available via the list endpoint.
            languageGroupKey: null,
            decisionDate: h.decisionDate,
            decisionType: h.decisionType,
            authorityScore: h.authorityScore,
            citationCount: h.citationCount,
            negativeCitationCount: h.negativeCitationCount,
            positiveCitationCount: h.positiveCitationCount,
            supportiveCitationCount: h.supportiveCitationCount,
            sourceUrl: h.sourceUrl,
            sourceName: h.sourceName,
            headline: h.headline,
            createdAt: new Date(h.createdAt),
          })),
          facets: response.data.facets,
          nextCursor: response.data.nextCursor,
        };
      }

      const request = stripUndefined({
        limit: DEFAULT_PAGE_SIZE,
        cursor: pageParam,
        court: filters.court,
        country: filters.country,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        decisionType: filters.decisionType,
        language: filters.language,
        sourceId: normalizeSourceId(filters.sourceId),
      });
      const response = await api.case.decisions.get({
        query: request,
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return {
        decisions: response.data.decisions.map((decision) => ({
          id: decision.id,
          caseNumber: decision.caseNumber,
          ecli: decision.ecli,
          court: decision.court,
          country: decision.country,
          language: decision.language,
          languageGroupKey: decision.languageGroupKey,
          decisionDate: decision.decisionDate,
          decisionType: decision.decisionType,
          sourceUrl: decision.sourceUrl,
          createdAt: decision.createdAt,
          authorityScore: decision.authorityScore,
          citationCount: decision.citationCount,
          negativeCitationCount: decision.negativeCitationCount,
          positiveCitationCount: decision.positiveCitationCount,
          sourceName: decision.sourceName,
          supportiveCitationCount: decision.supportiveCitationCount,
        })),
        facets: response.data.facets,
        nextCursor: response.data.nextCursor,
      };
    },
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
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
