import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { FetchStatus, QueryClient } from "@tanstack/react-query";

import {
  decisionFilterFacetsFromBrowse,
  orderCourtTiers,
  yearsNewestFirst,
} from "@/features/case-law/decision-filter-facets.logic";
import type { DecisionFilterFacets } from "@/features/case-law/decision-filter-facets.logic";
import { decisionFacetsOptions } from "@/features/case-law/queries/decisions";
import type {
  CaseLawBrowseFacets,
  SearchFacets,
} from "@/features/case-law/queries/decisions";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { prefetchRouteQuery } from "@/lib/react-query";

type PrefetchDecisionFacetsAfterSearchOptions<T> = {
  country: string;
  queryClient: QueryClient;
  search: Promise<T>;
};

/** Facets use the same admission slot as search, but never hold up the route. */
export const prefetchDecisionFacetsAfterSearch = async <T>({
  country,
  queryClient,
  search,
}: PrefetchDecisionFacetsAfterSearchOptions<T>): Promise<T> =>
  await search.finally(() => {
    detached(
      prefetchRouteQuery(
        queryClient,
        decisionFacetsOptions(country),
        (error) => {
          getAnalytics().captureError(error);
        },
      ),
      "cases.facets-prefetch",
    );
  });

type UseDecisionBrowseFacetsOptions = {
  country: string;
  searchFetched: boolean;
  searchFetchStatus: FetchStatus;
};

/** Background navigations also wait for their own result query to settle. */
export const useDecisionBrowseFacets = ({
  country,
  searchFetched,
  searchFetchStatus,
}: UseDecisionBrowseFacetsOptions) =>
  useQuery({
    ...decisionFacetsOptions(country),
    enabled: searchFetched && searchFetchStatus === "idle",
    placeholderData: keepPreviousData,
  });

/**
 * The one place the served facet shapes are read. Two endpoints answer with
 * facets — a search, which knows what its own result set holds, and the
 * corpus-wide browse listing, which knows what the jurisdiction holds — and
 * the filter popover draws one shape, so the difference is resolved here
 * rather than in the popover's branches.
 */
export const decisionFilterFacets = ({
  browse,
  search,
}: {
  browse: CaseLawBrowseFacets;
  /** Null while browsing, and on a cursor page, which recounts nothing. */
  search: SearchFacets | null;
}): DecisionFilterFacets =>
  search === null
    ? decisionFilterFacetsFromBrowse(browse)
    : {
        courtTiers: orderCourtTiers(search.court),
        year: yearsNewestFirst(search.year),
        decisionType: search.decisionType,
        language: search.language,
        source: search.source,
      };
