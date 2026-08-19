import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { assertPublicLawApiData } from "@/lib/public-law-api";
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
};

export const citingDecisionsInfiniteOptions = (key: CitingDecisionsKey) =>
  infiniteQueryOptions({
    queryKey: citingDecisionKeys.forProvision(key),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.case.provisions["citing-decisions"].get({
        query: {
          anchor: key.anchor,
          eli: key.eli,
          jurisdiction: key.jurisdiction,
          limit: PAGE_SIZE,
          ...(pageParam !== null && { cursor: pageParam }),
        },
        fetch: { signal },
      });

      const data = unwrapEden(response);
      assertPublicLawApiData(data, "listPublicCitingDecisions");

      return data;
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
