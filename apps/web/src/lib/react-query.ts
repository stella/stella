import type {
  EnsureQueryDataOptions,
  FetchQueryOptions,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";

/**
 * Typed input shape for query option factories.
 *
 * - **`TKey`**: fields that go into `queryKey` (cache identity).
 * - **`TContext`**: runtime deps for `queryFn` (not in cache key).
 *
 * When `TContext` is omitted the type flattens to just `TKey`
 * (no `key`/`context` wrapper needed).
 */
export type QueryOptionsInput<
  TKey extends Record<string, unknown>,
  TContext extends Record<string, unknown> | undefined = undefined,
> = TContext extends undefined ? TKey : { key: TKey; context: TContext };

const CRITICAL_QUERY_TIMEOUT_MS = 10_000;

export const ensureCriticalQueryData = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<TData> => {
  const signal = AbortSignal.timeout(CRITICAL_QUERY_TIMEOUT_MS);

  return await Promise.race([
    queryClient.ensureQueryData(options),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Query timed out", { cause: signal.reason })),
        { once: true },
      );
    }),
  ]);
};

export const prefetchNonCriticalQuery = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  onError: (error: unknown) => void,
) => {
  try {
    await queryClient.fetchQuery(options);
  } catch (error) {
    onError(error);
  }
};
