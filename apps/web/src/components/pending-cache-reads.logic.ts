import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The newest settled data among `entries` (what `getQueriesData` returned for
 * a key), for a loading view that reads what an earlier visit left without
 * loading the query that reads it. Several entries arise for reads the cache
 * keys one level finer than a loading view can name (a matter's views by the
 * language they were named in, the organization's settings by the caller);
 * the newest one is the one the page reads. A read whose last fetch failed
 * counts as absent, as it does for the page.
 */
export const newestCachedData = <TData>(
  queryClient: QueryClient,
  entries: readonly (readonly [QueryKey, TData | undefined])[],
): TData | undefined => {
  let newest: { data: TData; updatedAt: number } | undefined;
  for (const [key, data] of entries) {
    const state = queryClient.getQueryState(key);
    if (
      data !== undefined &&
      state?.error === null &&
      (newest === undefined || state.dataUpdatedAt > newest.updatedAt)
    ) {
      newest = { data, updatedAt: state.dataUpdatedAt };
    }
  }
  return newest?.data;
};
