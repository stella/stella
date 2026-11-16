import { hashKey } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { detached } from "@/lib/detached";

export type RealtimeRefreshScheduler = {
  refresh: (queryKey: QueryKey, prepare?: () => void, match?: "exact") => void;
  invalidateImmediately: (queryKey: QueryKey) => Promise<void>;
};

/**
 * Keeps push-driven refreshes single-flight without losing an event that
 * arrives after the current request began.
 */
export const createRealtimeRefreshScheduler = (
  queryClient: QueryClient,
): RealtimeRefreshScheduler => {
  const pending = new Map<
    string,
    {
      queryKey: QueryKey;
      prepare: (() => void) | undefined;
      match: "exact" | undefined;
    }
  >();
  const queryCache = queryClient.getQueryCache();

  const isFetching = (queryKey: QueryKey, match?: "exact") =>
    queryCache
      .findAll({ queryKey, exact: match === "exact" })
      .some(({ state }) => state.fetchStatus === "fetching");

  const startRefresh = (
    queryKey: QueryKey,
    prepare?: () => void,
    match?: "exact",
  ) => {
    prepare?.();
    detached(
      queryClient.invalidateQueries(
        { queryKey, exact: match === "exact" },
        { cancelRefetch: false },
      ),
      "realtime-refresh.invalidate",
    );
  };

  queryCache.subscribe(() => {
    for (const [keyHash, { queryKey, prepare, match }] of pending) {
      if (isFetching(queryKey, match)) {
        continue;
      }
      pending.delete(keyHash);
      startRefresh(queryKey, prepare, match);
    }
  });

  return {
    refresh: (queryKey, prepare, match) => {
      if (isFetching(queryKey, match)) {
        pending.set(`${match ?? "prefix"}:${hashKey(queryKey)}`, {
          queryKey,
          prepare,
          match,
        });
        return;
      }
      startRefresh(queryKey, prepare, match);
    },
    invalidateImmediately: async (queryKey) =>
      await queryClient.invalidateQueries({ queryKey }),
  };
};

const schedulers = new WeakMap<QueryClient, RealtimeRefreshScheduler>();

export const getRealtimeRefreshScheduler = (queryClient: QueryClient) => {
  const existing = schedulers.get(queryClient);
  if (existing) {
    return existing;
  }
  const scheduler = createRealtimeRefreshScheduler(queryClient);
  schedulers.set(queryClient, scheduler);
  return scheduler;
};
