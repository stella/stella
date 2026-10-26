import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";

export const WORKSPACE_NAVIGATION_STATUS_SCOPE = {
  ACTIVE: "active",
  ACTIVE_AND_ARCHIVED: "active-and-archived",
} as const;

type WorkspaceNavigationStatusScope =
  (typeof WORKSPACE_NAVIGATION_STATUS_SCOPE)[keyof typeof WORKSPACE_NAVIGATION_STATUS_SCOPE];

export type MemoryScope = "organization" | "user" | "workspace";
export type MemoryStatus = "suggested" | "active" | "stale" | "archived";
type MemoryKind =
  "preference" | "instruction" | "fact" | "decision" | "relationship";

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
  const response = await api.memories.get({
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
  return unwrapApiResponse(response);
};

type MemoriesPage = Awaited<ReturnType<typeof fetchMemoriesPage>>;
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

export const createMemory = async (
  options: CreateMemoryOptions,
  request: IdempotentRequest,
) => {
  const response = await api.memories.post(
    options.scope === "workspace"
      ? {
          ...options,
          workspaceId: toSafeId<"workspace">(options.workspaceId),
        }
      : options,
    request,
  );
  return unwrapApiResponse(response);
};

type CreateFirmMemoryOptions = {
  content: string;
  kind: "preference" | "instruction";
};

export const createFirmMemory = async (options: CreateFirmMemoryOptions) => {
  const response = await api.memories.firm.post(options);
  return unwrapApiResponse(response);
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
  const response = await api
    .memories({
      memoryId: toSafeId<"aiMemory">(memoryId),
    })
    .patch({
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
  return unwrapApiResponse(response);
};

export const deleteMemory = async (memoryId: string) => {
  const response = await api
    .memories({
      memoryId: toSafeId<"aiMemory">(memoryId),
    })
    .delete();
  return unwrapApiResponse(response);
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
  const page = unwrapApiResponse(response);
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

type WorkspaceNavigationPage = Awaited<
  ReturnType<typeof fetchWorkspaceNavigationPage>
>;
export type WorkspaceNavigationItem = WorkspaceNavigationPage["items"][number];
