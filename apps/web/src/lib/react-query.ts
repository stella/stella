import type {
  EnsureQueryDataOptions,
  FetchInfiniteQueryOptions,
  FetchQueryOptions,
  InfiniteData,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { TaggedError } from "better-result";

import { STALE_TIME } from "@/lib/consts";

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
export const ROUTE_QUERY_STALE_TIME_MS = STALE_TIME.FIVE.MINUTES;

export class CriticalQueryTimeoutError extends TaggedError(
  "CriticalQueryTimeoutError",
)<{
  message: string;
  queryKey: QueryKey;
  timeoutMs: number;
}>() {}

type EnsureCriticalQueryDataConfig = {
  timeoutMs?: number;
};

const formatQueryKey = (queryKey: QueryKey): string => {
  try {
    return JSON.stringify(queryKey);
  } catch {
    return "[unserializable query key]";
  }
};

const withCriticalQueryTimeout = async <TData>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  operation: () => Promise<TData>,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<TData> => {
  const timeoutMs = config.timeoutMs ?? CRITICAL_QUERY_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          void queryClient.cancelQueries(
            {
              exact: true,
              queryKey,
            },
            { revert: false },
          );
          reject(
            new CriticalQueryTimeoutError({
              message: `Critical query timed out after ${timeoutMs}ms: ${formatQueryKey(queryKey)}`,
              queryKey,
              timeoutMs,
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

export const ensureCriticalQueryData = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<TQueryFnData, TError, TData, TQueryKey>,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<TData> =>
  await withCriticalQueryTimeout(
    queryClient,
    options.queryKey,
    async () => await queryClient.ensureQueryData(options),
    config,
  );

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

type RouteFreshenableQueryOptions = {
  staleTime?: unknown;
};

const resolveRouteStaleTime = ({
  staleTime,
}: RouteFreshenableQueryOptions): number =>
  typeof staleTime === "number" ? staleTime : ROUTE_QUERY_STALE_TIME_MS;

export const routeQueryOptions = <TOptions extends object>(
  options: TOptions,
): TOptions & { staleTime: number } => ({
  ...options,
  staleTime: resolveRouteStaleTime(options),
});

export const ensureRouteQueryData = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<TQueryFnData, TError, TData, TQueryKey>,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<TData> =>
  await withCriticalQueryTimeout(
    queryClient,
    options.queryKey,
    async () => await queryClient.fetchQuery(routeQueryOptions(options)),
    config,
  );

export const fetchRouteQuery = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<TData> => await queryClient.fetchQuery(routeQueryOptions(options));

export const prefetchRouteQuery = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  onError: (error: unknown) => void,
) => {
  await prefetchNonCriticalQuery(
    queryClient,
    routeQueryOptions(options),
    onError,
  );
};

export const ensureRouteInfiniteQueryData = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  queryClient: QueryClient,
  options: FetchInfiniteQueryOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<InfiniteData<TData, TPageParam>> =>
  await withCriticalQueryTimeout(
    queryClient,
    options.queryKey,
    async () =>
      await queryClient.fetchInfiniteQuery(routeQueryOptions(options)),
    config,
  );
