import { api, memoriesApi } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

export const WORKSPACE_NAVIGATION_STATUS_SCOPE = {
  ACTIVE: "active",
  ACTIVE_AND_ARCHIVED: "active-and-archived",
} as const;

export type WorkspaceNavigationStatusScope =
  (typeof WORKSPACE_NAVIGATION_STATUS_SCOPE)[keyof typeof WORKSPACE_NAVIGATION_STATUS_SCOPE];

export type MemoryScope = "organization" | "user" | "workspace";
export type MemoryStatus = "suggested" | "active" | "stale" | "archived";
export type MemoryKind =
  | "preference"
  | "instruction"
  | "fact"
  | "decision"
  | "relationship";

type FetchMemoriesPageOptions = {
  cursor: string | null;
  limit: number;
  scope?: MemoryScope | undefined;
  signal?: AbortSignal | undefined;
  status?: MemoryStatus | undefined;
  workspaceId?: string | undefined;
};

export const fetchMemoriesPage = async ({
  cursor,
  limit,
  scope,
  signal,
  status,
  workspaceId,
}: FetchMemoriesPageOptions) => {
  const response = await memoriesApi.get({
    ...(signal ? { fetch: { signal } } : {}),
    query: {
      limit,
      ...(cursor !== null ? { cursor } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(workspaceId !== undefined
        ? { workspaceId: toSafeId<"workspace">(workspaceId) }
        : {}),
    },
  });
  return unwrapEden(response);
};

export type MemoriesPage = Awaited<ReturnType<typeof fetchMemoriesPage>>;
export type MemoryListItem = MemoriesPage["items"][number];

type CreateMemoryOptions =
  | {
      content: string;
      kind: MemoryKind;
      scope: "user";
      workspaceId?: never;
    }
  | {
      content: string;
      kind: MemoryKind;
      scope: "workspace";
      workspaceId: string;
    };

export const createMemory = async (options: CreateMemoryOptions) => {
  const response = await memoriesApi.post(
    options.scope === "workspace"
      ? {
          ...options,
          workspaceId: toSafeId<"workspace">(options.workspaceId),
        }
      : options,
  );
  return unwrapEden(response);
};

export type PersistedMemoryResult = Awaited<ReturnType<typeof createMemory>>;

type CreateFirmMemoryOptions = {
  content: string;
  kind: "preference" | "instruction";
};

export const createFirmMemory = async (options: CreateFirmMemoryOptions) => {
  const response = await memoriesApi.firm.post(options);
  return unwrapEden(response);
};

type UpdateMemoryOptions = {
  body: {
    content?: string | undefined;
    pinned?: boolean | undefined;
    status?: "active" | "archived" | undefined;
  };
  memoryId: string;
};

export const updateMemory = async ({ body, memoryId }: UpdateMemoryOptions) => {
  const response = await memoriesApi({
    memoryId: toSafeId<"aiMemory">(memoryId),
  }).patch({
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  });
  return unwrapEden(response);
};

export const deleteMemory = async (memoryId: string) => {
  const response = await memoriesApi({
    memoryId: toSafeId<"aiMemory">(memoryId),
  }).delete();
  return unwrapEden(response);
};

type FetchWorkspaceNavigationPageArgs = {
  cursor?: string | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
  statusScope: WorkspaceNavigationStatusScope;
};

export const fetchWorkspaceNavigationPage = async ({
  cursor,
  limit,
  signal,
  statusScope,
}: FetchWorkspaceNavigationPageArgs) => {
  const response = await api.workspaces.navigation.get({
    ...(signal ? { fetch: { signal } } : {}),
    query: {
      statusScope,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  });
  const page = unwrapEden(response);
  const restoreDates = (item: (typeof page.items)[number]) => ({
    ...item,
    lastActivityAt: new Date(item.lastActivityAt),
  });
  return {
    ...page,
    items: page.items.map(restoreDates),
    workspaces: page.workspaces.map(restoreDates),
  };
};

export type WorkspaceNavigationPage = Awaited<
  ReturnType<typeof fetchWorkspaceNavigationPage>
>;
export type WorkspaceNavigationItem = WorkspaceNavigationPage["items"][number];
