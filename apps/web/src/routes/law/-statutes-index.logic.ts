import type { QueryClient } from "@tanstack/react-query";

import {
  publicLawPageIndex,
  publicLawPageNumber,
  publicLawPageSize,
  publicLawPagesToWalk,
} from "@/components/public-law-table/public-law-pagination.logic";
import { publicLawLoadMode } from "@/components/public-law-table/public-law-results-state.logic";
import { createStatuteFilters } from "@/features/statutes/open-statute-match";
import {
  statuteFacetsOptions,
  statutesInfiniteOptions,
  type StatuteListFilters,
  type StatuteListItem,
} from "@/features/statutes/queries/statutes";
import {
  readStatuteIntent,
  type StatutesIndexSearch,
} from "@/features/statutes/statute-index-search.logic";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import {
  ensureRouteInfiniteQueryData,
  prefetchRouteQuery,
} from "@/lib/react-query";

/** What the list asks the corpus for: the entry, narrowed by the filters. */
export const createStatuteListFilters = (
  country: string,
  search: StatutesIndexSearch,
): StatuteListFilters => ({
  ...createStatuteFilters(country, readStatuteIntent(country, search.q)),
  ...(search.type === undefined ? {} : { documentType: search.type }),
  ...(search.validity === undefined ? {} : { validity: search.validity }),
  ...(search.year === undefined ? {} : { year: search.year }),
});

/**
 * The page the document describes: its rows are what the crawler reads and
 * what the collection markup lists.
 */
const shownStatutes = (
  walked: { pages: readonly { items: StatuteListItem[] }[] } | undefined,
  page: number | undefined,
): StatuteListItem[] => {
  if (walked === undefined) {
    return [];
  }
  const shown = walked.pages.at(
    publicLawPageIndex(publicLawPageNumber(page), walked.pages.length),
  );
  return shown ? shown.items : [];
};

type LoadPublicStatutesIndexOptions = {
  cause: "enter" | "preload" | "stay";
  country: string;
  queryClient: QueryClient;
  search: StatutesIndexSearch;
};

export const loadPublicStatutesIndex = async ({
  cause,
  country,
  queryClient,
  search,
}: LoadPublicStatutesIndexOptions) => {
  const intent = readStatuteIntent(country, search.q);
  // Full-text runs after hydration so the API receives the visitor's peer address.
  if (intent.type === "text") {
    return { statutes: [] };
  }

  // The type filter's choices: warmed, never awaited, so a slow facet read
  // cannot hold the list back.
  detached(
    prefetchRouteQuery(
      queryClient,
      statuteFacetsOptions(country.toUpperCase()),
      (error: unknown) => {
        getAnalytics().captureError(error);
      },
    ),
    "statutes.facets-prefetch",
  );
  const options = statutesInfiniteOptions(
    createStatuteListFilters(country, search),
    publicLawPageSize(search.pageSize),
  );
  const cached = queryClient.getQueryData(options.queryKey);

  // A filter, a search or a page step on a list that is already drawn: the
  // components hold the previous rows and swap them in place, so awaiting
  // here would only replace a live page with a skeleton.
  if (
    publicLawLoadMode({ cause, hasCachedPages: cached !== undefined }) ===
    "background"
  ) {
    return { statutes: shownStatutes(cached, search.page) };
  }

  // `beforeLoad` has already walked a deep link's chain, so this is a cache
  // read for that case and the first fetch otherwise.
  const walked = cached?.pages.length ?? 0;
  const wanted = publicLawPageNumber(search.page);
  const pages = await ensureRouteInfiniteQueryData(queryClient, {
    ...options,
    ...(wanted > 1 &&
      wanted > walked && { pages: publicLawPagesToWalk(wanted, walked) }),
  });

  return { statutes: shownStatutes(pages, search.page) };
};
