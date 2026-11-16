import { matchQuery, type QueryClient } from "@tanstack/react-query";

import { detached } from "@/lib/detached";
import {
  WORKSPACE_REALTIME_QUERY_ACTION,
  type WorkspaceRealtimeQueryAction,
} from "@/lib/workspace-realtime";

/**
 * Applies realtime or reconnect cache actions to a test client: removals
 * first, then every invalidation marked stale before active readers refetch.
 * The refetch is not awaited, so a test can hold a read open and observe it.
 */
export const applyResourceQueryActions = async (
  queryClient: QueryClient,
  actions: readonly WorkspaceRealtimeQueryAction[],
) => {
  for (const action of actions) {
    if (action.type === WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX) {
      queryClient.removeQueries({ queryKey: action.queryKey, exact: false });
    }
  }
  const invalidations = actions.filter(
    (action) => action.type === WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
  );
  await Promise.all(
    invalidations.map(async ({ queryKey }) => {
      await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    }),
  );
  detached(
    queryClient.refetchQueries({
      type: "active",
      predicate: (query) =>
        invalidations.some(({ queryKey }) => matchQuery({ queryKey }, query)),
    }),
    "resource-query.refresh",
  );
};
