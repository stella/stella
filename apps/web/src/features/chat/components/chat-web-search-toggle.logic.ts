import type { QueryClient, QueryKey } from "@tanstack/react-query";

type ChatWebSearchQuerySnapshot = readonly [QueryKey, unknown];

export const restoreChatWebSearchQuerySnapshots = (
  queryClient: QueryClient,
  snapshots: readonly ChatWebSearchQuerySnapshot[],
): void => {
  for (const [queryKey, data] of snapshots) {
    // Restore only the exact entry if it still exists. A query removed while
    // the mutation was pending must stay absent instead of being resurrected
    // by rollback, and sibling variants under the same prefix stay untouched.
    queryClient.setQueriesData({ exact: true, queryKey }, data);
  }
};
