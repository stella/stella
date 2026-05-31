import type {
  EnsureQueryDataOptions,
  FetchQueryOptions,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { TaggedError } from "better-result";

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

export const ensureCriticalQueryData = async <
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<TQueryFnData, TError, TData, TQueryKey>,
  config: EnsureCriticalQueryDataConfig = {},
): Promise<TData> => {
  const timeoutMs = config.timeoutMs ?? CRITICAL_QUERY_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      queryClient.ensureQueryData(options),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          void queryClient.cancelQueries({
            exact: true,
            queryKey: options.queryKey,
          });
          reject(
            new CriticalQueryTimeoutError({
              message: `Critical query timed out after ${timeoutMs}ms: ${formatQueryKey(options.queryKey)}`,
              queryKey: options.queryKey,
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
