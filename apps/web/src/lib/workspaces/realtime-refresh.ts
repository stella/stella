import { hashKey } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { detached } from "@/lib/detached";

export type RealtimeRefreshScheduler = {
  refresh: (queryKey: QueryKey, prepare?: () => void) => void;
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
    { queryKey: QueryKey; prepare: (() => void) | undefined }
  >();
  const queryCache = queryClient.getQueryCache();

  const isFetching = (queryKey: QueryKey) =>
    queryCache
      .findAll({ queryKey })
      .some(({ state }) => state.fetchStatus === "fetching");

  const startRefresh = (queryKey: QueryKey, prepare?: () => void) => {
    prepare?.();
    detached(
      queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false }),
      "realtime-refresh.invalidate",
    );
  };

  queryCache.subscribe(() => {
    for (const [keyHash, { queryKey, prepare }] of pending) {
      if (isFetching(queryKey)) {
        continue;
      }
      pending.delete(keyHash);
      startRefresh(queryKey, prepare);
    }
  });

  return {
    refresh: (queryKey, prepare) => {
      if (isFetching(queryKey)) {
        pending.set(hashKey(queryKey), { queryKey, prepare });
        return;
      }
      startRefresh(queryKey, prepare);
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
