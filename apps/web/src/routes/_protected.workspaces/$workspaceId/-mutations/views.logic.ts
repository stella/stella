import type { QueryClient } from "@tanstack/react-query";

import type { WorkspaceView } from "@/lib/types";
import { viewsKeys } from "@/lib/workspaces/queries/views";

/**
 * Returns the cached view list in `viewIds` order, or `current` unchanged when
 * the cache has drifted from what was dragged.
 *
 * The server only accepts the workspace's full view set, so a partial write
 * would drop a view off the strip rather than leave it to the refetch.
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

  return reordered.length === current.length ? reordered : current;
};

/** What the optimistic write displaced, so a failed reorder can put it back. */
export type ReorderViewsContext = {
  previousViews: WorkspaceView[] | undefined;
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

      queryClient.setQueryData<WorkspaceView[]>(localizedKey, (current) =>
        reorderCachedViews(current, viewIds),
      );

      return { previousViews };
    },

    restore: (context: ReorderViewsContext | undefined) => {
      if (!context?.previousViews) {
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
