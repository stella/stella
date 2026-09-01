import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { CaseLawResearchSavedQuery } from "@stll/api-contract";

import type { DecisionListFilters } from "@/features/case-law/queries/decisions";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const RESEARCH_TABLES_PAGE_SIZE = 50;

type ResearchTablesListKey = { activeOrganizationId: string };
type ResearchTableKey = { activeOrganizationId: string; tableId: string };

/** Keyed by organization: a member sees a different set in each firm. */
export const researchTableKeys = {
  all: ["case-law", "research-tables"],
  list: ({ activeOrganizationId }: ResearchTablesListKey) => [
    ...researchTableKeys.all,
    "list",
    { activeOrganizationId },
  ],
  detail: ({ activeOrganizationId, tableId }: ResearchTableKey) => [
    ...researchTableKeys.all,
    "detail",
    { activeOrganizationId, tableId },
  ],
};

export const researchTablesInfiniteOptions = (key: ResearchTablesListKey) =>
  infiniteQueryOptions({
    queryKey: researchTableKeys.list(key),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.case.research.get({
        query: {
          limit: RESEARCH_TABLES_PAGE_SIZE,
          ...(pageParam !== null && { cursor: pageParam }),
        },
        fetch: { signal },
      });
      return unwrapEden(response);
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const researchTableOptions = (key: ResearchTableKey) =>
  queryOptions({
    queryKey: researchTableKeys.detail(key),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .research({ tableId: toSafeId<"caseLawResearchTable">(key.tableId) })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type ResearchTableDetail = Awaited<
  ReturnType<NonNullable<ReturnType<typeof researchTableOptions>["queryFn"]>>
>;

export type ResearchTableSummary = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof researchTablesInfiniteOptions>["queryFn"]>
  >
>["items"][number];

/** The saved query as the decision list/search query expects its filters. */
export const savedQueryToDecisionFilters = (
  savedQuery: CaseLawResearchSavedQuery,
): DecisionListFilters => ({
  search: savedQuery.query,
  ...(savedQuery.country !== undefined && { country: savedQuery.country }),
  ...(savedQuery.court !== undefined && { court: savedQuery.court }),
  ...(savedQuery.dateFrom !== undefined && { dateFrom: savedQuery.dateFrom }),
  ...(savedQuery.dateTo !== undefined && { dateTo: savedQuery.dateTo }),
  ...(savedQuery.decisionType !== undefined && {
    decisionType: savedQuery.decisionType,
  }),
  ...(savedQuery.language !== undefined && { language: savedQuery.language }),
  ...(savedQuery.sourceId !== undefined && { sourceId: savedQuery.sourceId }),
});

/** The current search, as the saved query a new research table stores. */
export const decisionFiltersToSavedQuery = (
  filters: DecisionListFilters & { search: string },
): CaseLawResearchSavedQuery => ({
  version: 1,
  query: filters.search,
  ...(filters.country !== undefined && { country: filters.country }),
  ...(filters.court !== undefined && { court: filters.court }),
  ...(filters.dateFrom !== undefined && { dateFrom: filters.dateFrom }),
  ...(filters.dateTo !== undefined && { dateTo: filters.dateTo }),
  ...(filters.decisionType !== undefined && {
    decisionType: filters.decisionType,
  }),
  ...(filters.language !== undefined && { language: filters.language }),
  ...(filters.sourceId !== undefined && {
    sourceId: toSafeId<"caseLawSource">(filters.sourceId),
  }),
});
