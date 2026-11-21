import { infiniteQueryOptions } from "@tanstack/react-query";

import {
  fetchWorkspaceNavigationPage,
  WORKSPACE_NAVIGATION_STATUS_SCOPE,
} from "@/lib/memory-api";
import type { WorkspaceNavigationCaller } from "@/lib/workspaces/queries.logic";

const getInitialMemoryMatterCursor = (): string | undefined => undefined;

const memoryMatterKeys = {
  all: ({ organizationId, userId }: WorkspaceNavigationCaller) => [
    "memory-matters",
    organizationId,
    userId,
  ],
};

export const memoryMattersOptions = (caller: WorkspaceNavigationCaller) =>
  infiniteQueryOptions({
    queryKey: memoryMatterKeys.all(caller),
    queryFn: async ({ pageParam, signal }) =>
      await fetchWorkspaceNavigationPage({
        cursor: pageParam,
        signal,
        statusScope: WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE_AND_ARCHIVED,
      }),
    initialPageParam: getInitialMemoryMatterCursor(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
