import { hashKey } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { isObservedSessionQueryOwner } from "@/lib/account/auth-query-owner";
import { detached } from "@/lib/detached";
import {
  canInvalidateResourceQuery,
  canRefreshResourceQuery,
  isIdentityOwnedResourceQuery,
  isResourceQueryAwaitingAuthority,
  resourceRefreshIdentity,
} from "@/lib/workspaces/resource-query-identity";
import type { ResourceRefreshContext } from "@/lib/workspaces/resource-query-identity";

export type RealtimeRefreshScheduler = {
  refresh: (
    queryKey: QueryKey,
    prepare?: () => void,
    context?: ResourceRefreshContext,
  ) => void;
  invalidateImmediately: (
    queryKey: QueryKey,
    context?: ResourceRefreshContext,
  ) => Promise<void>;
};

type PendingRefresh = {
  queryKey: QueryKey;
  prepare: (() => void) | undefined;
  context: ResourceRefreshContext;
};

/** Single-flight refreshes retain the subscription and Query that queued them. */
export const createRealtimeRefreshScheduler = (
  queryClient: QueryClient,
): RealtimeRefreshScheduler => {
  const pending = new Map<object, Map<string, PendingRefresh>>();
  const queryCache = queryClient.getQueryCache();
  const isCurrent = ({ queryKey, context }: PendingRefresh) =>
    (context.owner === undefined ||
      isObservedSessionQueryOwner(queryClient, context.owner)) &&
    (context.query === undefined ||
      queryCache.find({ queryKey, exact: true }) === context.query);
  const isFetching = ({ queryKey, context }: PendingRefresh) =>
    queryCache
      .findAll({ queryKey, exact: context.match === "exact" })
      .some(
        (query) =>
          canRefreshResourceQuery(queryClient, query, context) &&
          query.state.fetchStatus === "fetching",
      );
  const retain = (refresh: PendingRefresh) => {
    const identity = resourceRefreshIdentity(refresh.context);
    const entries = pending.get(identity) ?? new Map<string, PendingRefresh>();
    entries.set(hashKey(refresh.queryKey), refresh);
    pending.set(identity, entries);
  };
  const awaitsAuthority = ({ queryKey, context }: PendingRefresh) =>
    queryCache
      .findAll({ queryKey, exact: context.match === "exact" })
      .some((query) =>
        isResourceQueryAwaitingAuthority(queryClient, query, context),
      );
  const markStale = async ({ queryKey, context }: PendingRefresh) => {
    await queryClient.invalidateQueries({
      queryKey,
      exact: context.match === "exact",
      predicate: (query) =>
        canInvalidateResourceQuery(queryClient, query, context),
      refetchType: "none",
    });
  };
  const invalidate = async (
    refresh: PendingRefresh,
    cancelRefetch: boolean,
  ) => {
    const { queryKey, context } = refresh;
    if (!isCurrent({ queryKey, context, prepare: undefined })) {
      return;
    }
    if (
      context.query === undefined ||
      !isIdentityOwnedResourceQuery(context.query)
    ) {
      // Keep the established synchronous idle-start behavior for legacy readers.
      await queryClient.invalidateQueries(
        {
          queryKey,
          exact: context.match === "exact",
          predicate: (query) =>
            canRefreshResourceQuery(queryClient, query, context),
        },
        { cancelRefetch },
      );
      return;
    }
    await markStale(refresh);
    if (!isCurrent(refresh)) {
      return;
    }
    // Session authority may have changed during the awaited stale marking.
    if (awaitsAuthority(refresh)) {
      retain(refresh);
      return;
    }
    await queryClient.refetchQueries(
      {
        queryKey,
        exact: context.match === "exact",
        type: "active",
        predicate: (query) =>
          canRefreshResourceQuery(queryClient, query, context),
      },
      { cancelRefetch },
    );
  };
  const startRefresh = (refresh: PendingRefresh) => {
    if (!isCurrent(refresh)) {
      return;
    }
    if (
      queryCache
        .findAll({
          queryKey: refresh.queryKey,
          exact: refresh.context.match === "exact",
        })
        .some((query) =>
          canRefreshResourceQuery(queryClient, query, refresh.context),
        )
    ) {
      refresh.prepare?.();
    }
    detached(invalidate(refresh, false), "realtime-refresh.invalidate");
  };
  queryCache.subscribe(() => {
    for (const [identity, entries] of pending) {
      for (const [key, refresh] of entries) {
        if (!isCurrent(refresh)) {
          entries.delete(key);
        } else if (awaitsAuthority(refresh)) {
          continue;
        } else if (!isFetching(refresh)) {
          entries.delete(key);
          startRefresh(refresh);
        }
      }
      if (entries.size === 0) {
        pending.delete(identity);
      }
    }
  });
  return {
    refresh: (queryKey, prepare, context = {}) => {
      const refresh = { queryKey, prepare, context: { ...context } };
      if (!isCurrent(refresh)) {
        return;
      }
      if (awaitsAuthority(refresh)) {
        // Retain before invalidate emits synchronous cache notifications.
        retain(refresh);
        detached(markStale(refresh), "realtime-refresh.mark-stale");
        return;
      }
      if (isFetching(refresh)) {
        retain(refresh);
        return;
      }
      startRefresh(refresh);
    },
    invalidateImmediately: async (queryKey, context = {}) =>
      await invalidate(
        { queryKey, context: { ...context }, prepare: undefined },
        true,
      ),
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
