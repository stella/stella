import { QueryClient } from "@tanstack/react-query";
import type {
  InfiniteData,
  InfiniteQueryExecuteOptions,
  QueryExecuteOptions,
  QueryKey,
} from "@tanstack/react-query";
import { Result, TaggedError } from "better-result";

import { STALE_TIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { shouldRetryAPIRequest } from "@/lib/errors/api";

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
}> {}

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
          detached(
            queryClient.cancelQueries(
              {
                exact: true,
                queryKey,
              },
              { revert: false },
            ),
            "react-query.cancel-queries",
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
  options: QueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryFnData,
    TQueryKey
  >,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<TData> =>
  await withCriticalQueryTimeout(
    queryClient,
    options.queryKey,
    async () => await queryClient.query({ ...options, staleTime: "static" }),
    config,
  );

export const prefetchNonCriticalQuery = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryFnData,
    TQueryKey
  >,
  onError: (error: unknown) => void,
) => {
  const result = await Result.tryPromise({
    try: async () => await queryClient.query(options),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    onError(result.error);
  }
};

export const prefetchNonCriticalInfiniteQuery = async <
  TQueryFnData,
  TError = Error,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  queryClient: QueryClient,
  options: InfiniteQueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
  onError: (error: unknown) => void,
) => {
  const result = await Result.tryPromise({
    try: async () => await queryClient.infiniteQuery(options),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    onError(result.error);
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
  options: QueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryFnData,
    TQueryKey
  >,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<TData> =>
  await withCriticalQueryTimeout(
    queryClient,
    options.queryKey,
    async () => await queryClient.query(routeQueryOptions(options)),
    config,
  );

export const fetchRouteQuery = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryFnData,
    TQueryKey
  >,
): Promise<TData> => await queryClient.query(routeQueryOptions(options));

export const prefetchRouteQuery = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryFnData,
    TQueryKey
  >,
  onError: (error: unknown) => void,
) => {
  await prefetchNonCriticalQuery(
    queryClient,
    routeQueryOptions(options),
    onError,
  );
};

type InfiniteQueryExecutionResult<TQueryFnData, TData, TPageParam> =
  TData[] extends InfiniteData<TQueryFnData>[]
    ? InfiniteData<TQueryFnData, TPageParam>
    : TData;

export const ensureRouteInfiniteQueryData = async <
  TQueryFnData,
  TError = Error,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  queryClient: QueryClient,
  options: InfiniteQueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<InfiniteQueryExecutionResult<TQueryFnData, TData, TPageParam>> =>
  await withCriticalQueryTimeout(
    queryClient,
    options.queryKey,
    async () => await queryClient.infiniteQuery(routeQueryOptions(options)),
    config,
  );

/** The app's query cache, with the defaults every read shares. */
export const createAppQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.FIVE.MINUTES,
        // Route loaders fetch without retries unless a default says
        // otherwise, so one transient refusal (429, 5xx, a dropped
        // connection) would reach the route's error page. Mutations keep
        // TanStack's no-retry default: a write is never replayed silently.
        retry: shouldRetryAPIRequest,
      },
    },
  });
