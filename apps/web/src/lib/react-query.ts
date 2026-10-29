import {
  CancelledError,
  defaultShouldDehydrateQuery,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import type {
  FetchStatus,
  InfiniteData,
  InfiniteQueryExecuteOptions,
  Query,
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

type QueryReadObserver = {
  subscribe: (listener: () => void) => () => void;
  getCurrentQuery: () => {
    promise: Promise<unknown> | undefined;
    state: { fetchStatus: FetchStatus };
  };
};

/** A route still owns the flight when the component that started it leaves. */
const withQueryReadObserver = async <TData>(
  observer: QueryReadObserver,
  read: () => Promise<TData>,
): Promise<TData> => {
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    return await read();
  } finally {
    const query = observer.getCurrentQuery();
    // A cache hit can return while a background refresh still owns the flight.
    // Releasing its last observer here would cancel that unrelated read.
    if (query.state.fetchStatus === "fetching" && query.promise !== undefined) {
      detached(
        query.promise.then(unsubscribe, unsubscribe),
        "react-query.release-read-observer",
      );
    } else {
      unsubscribe();
    }
  }
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
          const timeoutError = new CriticalQueryTimeoutError({
            message: `Critical query timed out after ${timeoutMs}ms: ${formatQueryKey(queryKey)}`,
            queryKey,
            timeoutMs,
          });
          const query = queryClient
            .getQueryCache()
            .find({ exact: true, queryKey });
          detached(
            queryClient
              .cancelQueries({ exact: true, queryKey }, { revert: false })
              .then(() => {
                if (
                  query?.state.fetchStatus !== "idle" ||
                  !(query.state.error instanceof CancelledError)
                ) {
                  return undefined;
                }
                // The deadline is a read failure; the cancellation only stops its
                // transport. Mounted readers need the real failure to offer retry.
                query.setState({
                  error: timeoutError,
                  fetchFailureReason: timeoutError,
                });
                return undefined;
              }),
            "react-query.cancel-queries",
          );
          reject(timeoutError);
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
    async () =>
      await withQueryReadObserver(
        new QueryObserver(queryClient, { ...options, enabled: false }),
        async () =>
          await queryClient.query({ ...options, staleTime: "static" }),
      ),
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

export const routeQueryOptions = <TOptions extends object>(
  options: TOptions & RouteFreshenableQueryOptions,
) => {
  const { staleTime } = options;
  if (
    typeof staleTime === "number" ||
    typeof staleTime === "function" ||
    staleTime === "static"
  ) {
    return options;
  }
  return { ...options, staleTime: ROUTE_QUERY_STALE_TIME_MS };
};

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
    async () =>
      await withQueryReadObserver(
        new QueryObserver(queryClient, {
          ...routeQueryOptions(options),
          enabled: false,
        }),
        async () => await queryClient.query(routeQueryOptions(options)),
      ),
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
): Promise<TData> =>
  await withQueryReadObserver(
    new QueryObserver(queryClient, {
      ...routeQueryOptions(options),
      enabled: false,
    }),
    async () => await queryClient.query(routeQueryOptions(options)),
  );

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
    async () =>
      await withQueryReadObserver(
        new InfiniteQueryObserver(queryClient, {
          getNextPageParam: () => undefined,
          ...routeQueryOptions(options),
          enabled: false,
        }),
        async () => await queryClient.infiniteQuery(routeQueryOptions(options)),
      ),
    config,
  );

/**
 * Which queries a server render hands to the browser: only reads that
 * succeeded, TanStack's own default. The router integration offers a query
 * again each time it changes, so a read that settles while the page is still
 * streaming reaches the browser with its data.
 *
 * A pending read is left behind. Its in-flight promise would travel with it,
 * and the server can still cancel that read after the payload left (a loader
 * deadline, or the render teardown clearing the cache), so the browser would
 * resume a promise that rejects with `Error("redacted")`. The browser reads
 * the query itself instead.
 *
 * A failed read is left behind too: the SSR payload rebuilds every error as a
 * plain `Error`, so the browser would hold a failure it can no longer classify
 * (an outage reads as a crash). The loader already turned the failure into
 * route state, and the browser reads the query again on its own, with typed
 * errors.
 */
export const shouldDehydrateServerQuery = (query: Query): boolean =>
  defaultShouldDehydrateQuery(query);

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
