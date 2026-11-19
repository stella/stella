import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The newest settled data the cache holds under `queryKey`, for a loading view
 * that reads what an earlier visit left without loading the query that reads
 * it. `exact` reads that key alone; otherwise every key under it counts, for
 * reads the cache keys one level finer than a loading view can name (a
 * matter's views by the language they were named in, the organization's
 * settings by the caller), where the newest one is the one the page reads.
 * A read whose last fetch failed counts as absent, as it does for the page.
 */
export const newestCachedData = <TData>(
  queryClient: QueryClient,
  { exact = false, queryKey }: { exact?: boolean; queryKey: QueryKey },
): TData | undefined => {
  let newest: { data: TData; updatedAt: number } | undefined;
  for (const [key, data] of queryClient.getQueriesData<TData>({
    exact,
    queryKey,
  })) {
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
