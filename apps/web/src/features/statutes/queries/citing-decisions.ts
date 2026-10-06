import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { ProvisionCitingSearch } from "@/features/statutes/statute-page-search";
import { api } from "@/lib/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

/**
 * One provision's incoming case law, read on demand.
 *
 * A page of a consolidated code carries thousands of provisions, so this is
 * never started for the page: it is started for the one provision a reader
 * opened, and its cache key is that provision.
 */
const PAGE_SIZE = 10;

export type CitingDecisionsKey = {
  /** The provision's anchor in the statute text. */
  anchor: string;
  /** The work's own identifier, which is what the act knows itself by. */
  eli: string;
  jurisdiction: string;
};

export const citingDecisionKeys = {
  all: ["statutes", "citing-decisions"],
  forProvision: (key: CitingDecisionsKey) => [
    ...citingDecisionKeys.all,
    {
      anchor: key.anchor,
      eli: key.eli,
      jurisdiction: key.jurisdiction,
    },
  ],
  countsForWork: (key: Pick<CitingDecisionsKey, "eli" | "jurisdiction">) => [
    ...citingDecisionKeys.all,
    "counts",
    { eli: key.eli, jurisdiction: key.jurisdiction },
  ],
};

export const statuteCitationCountsOptions = (
  key: Pick<CitingDecisionsKey, "eli" | "jurisdiction">,
) =>
  queryOptions({
    queryKey: citingDecisionKeys.countsForWork(key),
    queryFn: async ({ signal }) => {
      const response = await api.case.provisions["citation-counts"].get({
        query: key,
        fetch: { signal },
      });

      return unwrapPublicLawEden(response, "readStatuteCitationCounts");
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** How many of the most authoritative citing decisions the view leads with. */
const TOP_CITING_LIMIT = 5;

/**
 * The provision's most authoritative citing decisions, one read and no
 * paging: the leading cases a reader wants first, and the passages the Ask
 * prompt is seeded with.
 */
export const topCitingDecisionsOptions = (key: CitingDecisionsKey) =>
  queryOptions({
    queryKey: [...citingDecisionKeys.forProvision(key), "top"],
    queryFn: async ({ signal }) => {
      const response = await api.case.provisions["citing-decisions"].get({
        query: {
          anchor: key.anchor,
          eli: key.eli,
          excerpt: "required",
          jurisdiction: key.jurisdiction,
          limit: TOP_CITING_LIMIT,
          sort: "authority",
        },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(
        response,
        "listPublicTopCitingDecisions",
      );

      return data.items;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const citingDecisionsInfiniteOptions = (
  key: CitingDecisionsKey,
  filters: ProvisionCitingSearch,
) => {
  const queryKey = [...citingDecisionKeys.forProvision(key), filters];
  return infiniteQueryOptions({
    queryKey,
    queryFn: async ({
      client,
      pageParam,
      signal,
      queryKey: activeQueryKey,
    }) => {
      const response = await api.case.provisions["citing-decisions"].get({
        query: {
          anchor: key.anchor,
          eli: key.eli,
          jurisdiction: key.jurisdiction,
          limit: PAGE_SIZE,
          sort: filters.citingSort,
          ...(filters.citingCourt ? { court: filters.citingCourt } : {}),
          ...(filters.citingYear === undefined
            ? {}
            : { year: filters.citingYear }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
        fetch: { signal },
      });

      if (pageParam !== null && response.error?.status === 409) {
        await client.resetQueries({ queryKey: activeQueryKey, exact: true });
      }
      const data = unwrapPublicLawEden(response, "listPublicCitingDecisions");

      return data;
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
};
