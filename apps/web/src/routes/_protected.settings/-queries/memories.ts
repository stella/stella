import { infiniteQueryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

export type MemoryScope = "organization" | "user" | "workspace";
export type MemoryStatus = "suggested" | "active" | "stale" | "archived";

type MemoriesPage = Awaited<ReturnType<typeof fetchMemoriesPage>>;
export type MemoryListItem = MemoriesPage["items"][number];

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

type FetchMemoriesPageArgs = {
  cursor: string | null;
  scope?: MemoryScope | undefined;
  signal?: AbortSignal | undefined;
  status?: MemoryStatus | undefined;
  workspaceId?: string | undefined;
};

const fetchMemoriesPage = async ({
  cursor,
  scope,
  signal,
  status,
  workspaceId,
}: FetchMemoriesPageArgs) => {
  const response = await api.memories.get({
    ...(signal !== undefined && { fetch: { signal } }),
    query: {
      limit: MEMORIES_PAGE_SIZE,
      ...(scope !== undefined && { scope }),
      ...(status !== undefined && { status }),
      ...(workspaceId !== undefined && {
        workspaceId: toSafeId<"workspace">(workspaceId),
      }),
      ...(cursor !== null && { cursor }),
    },
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
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
