import type { QueryClient } from "@tanstack/react-query";

import type { WorkspaceView } from "@/lib/types";
import { entityViewLayoutsRoot } from "@/lib/workspaces/queries/entity-view-layouts-key.logic";

/** The inbox's saved views as an earlier read left them, and whose they are. */
export type CachedEntityViews = {
  organizationId: string;
  views: readonly WorkspaceView[];
};

/**
 * The member's saved inbox views as the cache already holds them, for a
 * loading inbox that draws the strip and the active view's layout without
 * subscribing to the read: the newest settled read (the cache can hold
 * another organization's after a switch). `null` when there is none, as on a
 * cold load. Reads by key prefix alone, so the view that calls it loads no
 * API client.
 */
export const cachedEntityViews = (
  queryClient: QueryClient,
): CachedEntityViews | null => {
  let newest: (CachedEntityViews & { updatedAt: number }) | null = null;
  for (const [queryKey, data] of queryClient.getQueriesData<{
    items: WorkspaceView[];
  }>({ queryKey: entityViewLayoutsRoot() })) {
    const state = queryClient.getQueryState(queryKey);
    const organizationId = queryKey.at(1);
    if (
      data === undefined ||
      state === undefined ||
      state.error !== null ||
      typeof organizationId !== "string" ||
      (newest !== null && state.dataUpdatedAt <= newest.updatedAt)
    ) {
      continue;
    }
    newest = {
      organizationId,
      updatedAt: state.dataUpdatedAt,
      views: data.items,
    };
  }
  return newest === null
    ? null
    : { organizationId: newest.organizationId, views: newest.views };
};
