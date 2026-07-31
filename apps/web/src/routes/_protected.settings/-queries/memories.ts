import { infiniteQueryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { fetchMemoriesPage } from "@/lib/memory-api";
import type {
  MemoryListItem,
  MemoryScope,
  MemoryStatus,
} from "@/lib/memory-api";

export type {
  MemoryListItem,
  MemoryScope,
  MemoryStatus,
} from "@/lib/memory-api";

const MEMORIES_PAGE_SIZE = 50;
const INITIAL_PAGE_CURSOR = "";

type MemoriesPageKey = {
  activeOrganizationId: string;
  scope?: MemoryScope | undefined;
  status?: MemoryStatus | undefined;
  workspaceId?: string | undefined;
};

export const memoriesKeys = {
  all: (activeOrganizationId: string) =>
    ["memories", activeOrganizationId] as const,
  list: (key: MemoriesPageKey) => [
    ...memoriesKeys.all(key.activeOrganizationId),
    "list",
    key.scope ?? "any-scope",
    key.status ?? "any-status",
    key.workspaceId ?? "any-workspace",
  ],
};

type MemoriesOptionsInput = MemoriesPageKey;

export const memoriesOptions = ({
  activeOrganizationId,
  scope,
  status,
  workspaceId,
}: MemoriesOptionsInput) =>
  infiniteQueryOptions({
    queryKey: memoriesKeys.list({
      activeOrganizationId,
      scope,
      status,
      workspaceId,
    }),
    queryFn: async ({ pageParam, signal }) =>
      await fetchMemoriesPage({
        cursor: pageParam === INITIAL_PAGE_CURSOR ? null : pageParam,
        limit: MEMORIES_PAGE_SIZE,
        scope,
        signal,
        status,
        workspaceId,
      }),
    initialPageParam: INITIAL_PAGE_CURSOR,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

export const invalidateMemories = async (
  queryClient: QueryClient,
  activeOrganizationId: string,
) =>
  await queryClient.invalidateQueries({
    queryKey: memoriesKeys.all(activeOrganizationId),
  });
