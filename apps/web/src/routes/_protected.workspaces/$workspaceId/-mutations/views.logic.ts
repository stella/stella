import type { QueryClient } from "@tanstack/react-query";

import type { WorkspaceView } from "@/lib/types";
import { viewsKeys } from "@/lib/workspaces/queries/views";

/**
 * Returns the cached view list in `viewIds` order, or `current` unchanged when
 * `viewIds` is not a permutation of what is cached.
 *
 * The endpoint takes the workspace's full view set, so a partial write would
 * drop views off the strip until the refetch lands. Set equality, not just a
 * length check: a repeated id fills the list to the right length while silently
 * losing a view.
 */
export const reorderCachedViews = (
  current: WorkspaceView[] | undefined,
  viewIds: readonly string[],
): WorkspaceView[] | undefined => {
  if (!current) {
    return current;
  }

  const byId = new Map(current.map((view) => [view.id, view]));
  const reordered = viewIds
    .map((viewId) => byId.get(viewId))
    .filter((view) => view !== undefined);

  const isPermutation =
    reordered.length === current.length &&
    new Set(viewIds).size === current.length;

  return isPermutation ? reordered : current;
};

/** What the optimistic write displaced, so a failed reorder can put it back. */
export type ReorderViewsContext = {
  previousViews: WorkspaceView[] | undefined;
  /**
   * What the optimistic write left in the cache, so a rollback can tell whether
   * the strip is still showing this reorder.
   */
  optimisticViews: WorkspaceView[] | undefined;
};

type ViewOrderCacheOptions = {
  queryClient: QueryClient;
  workspaceId: string;
};

/**
 * The cache side of a view reorder, split from the hook so the optimistic
 * write, its rollback, and the settling invalidation are reachable from a test.
 */
export const viewOrderCache = ({
  queryClient,
  workspaceId,
}: ViewOrderCacheOptions) => {
  // Optimistic reads/writes target the concrete locale-specific entry; the
  // final invalidation targets the locale-independent prefix so every cached
  // locale variant refetches.
  const localizedKey = viewsKeys.localized(workspaceId);

  return {
    apply: async (viewIds: readonly string[]): Promise<ReorderViewsContext> => {
      await queryClient.cancelQueries({ queryKey: localizedKey });
      const previousViews =
        queryClient.getQueryData<WorkspaceView[]>(localizedKey);

      const optimisticViews = queryClient.setQueryData<WorkspaceView[]>(
        localizedKey,
        (current) => reorderCachedViews(current, viewIds),
      );

      return { previousViews, optimisticViews };
    },

    restore: (context: ReorderViewsContext | undefined) => {
      if (!context?.previousViews) {
        return;
      }
      // Nothing disables the strip while a reorder is in flight, so a second
      // drop can land first. Rolling this one back would then undo the newer
      // order and leave the strip wrong until the newer request settles. The
      // cache holds what `apply` wrote until something replaces it, so an
      // identity check answers "is this reorder still what the user sees?" for
      // a later drop and a landed refetch alike.
      if (queryClient.getQueryData(localizedKey) !== context.optimisticViews) {
        return;
      }
      queryClient.setQueryData(localizedKey, context.previousViews);
    },

    settle: async () => {
      await queryClient.invalidateQueries({
        queryKey: viewsKeys.all(workspaceId),
      });
    },
  };
};
