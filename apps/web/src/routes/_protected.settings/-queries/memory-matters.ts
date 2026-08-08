import { infiniteQueryOptions } from "@tanstack/react-query";

import {
  fetchWorkspaceNavigationPage,
  WORKSPACE_NAVIGATION_STATUS_SCOPE,
} from "@/lib/memory-api";
import type { WorkspaceNavigationItem } from "@/lib/memory-api";

export type MemoryMatter = WorkspaceNavigationItem;

const getInitialMemoryMatterCursor = (): string | undefined => undefined;

export const memoryMatterKeys = {
  all: (activeOrganizationId: string) => [
    "memory-matters",
    activeOrganizationId,
  ],
};

export const memoryMattersOptions = (activeOrganizationId: string) =>
  infiniteQueryOptions({
    queryKey: memoryMatterKeys.all(activeOrganizationId),
    queryFn: async ({ pageParam, signal }) =>
      await fetchWorkspaceNavigationPage({
        cursor: pageParam,
        signal,
        statusScope: WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE_AND_ARCHIVED,
      }),
    initialPageParam: getInitialMemoryMatterCursor(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
