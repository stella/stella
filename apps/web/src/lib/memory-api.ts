import * as v from "valibot";

import { apiUrl } from "@/lib/api-url";
import { toAPIError } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";

const REQUEST_TIMEOUT_MS = 15_000;

export const WORKSPACE_NAVIGATION_STATUS_SCOPE = {
  ACTIVE: "active",
  ACTIVE_AND_ARCHIVED: "active-and-archived",
} as const;

export type WorkspaceNavigationStatusScope =
  (typeof WORKSPACE_NAVIGATION_STATUS_SCOPE)[keyof typeof WORKSPACE_NAVIGATION_STATUS_SCOPE];

const memoryScopeSchema = v.picklist(["organization", "user", "workspace"]);
const memoryStatusSchema = v.picklist([
  "suggested",
  "active",
  "stale",
  "archived",
]);
const memoryKindSchema = v.picklist([
  "preference",
  "instruction",
  "fact",
  "decision",
  "relationship",
]);

const memoryListItemSchema = v.object({
  id: v.string(),
  scope: memoryScopeSchema,
  kind: memoryKindSchema,
  content: v.string(),
  language: v.nullable(v.string()),
  status: memoryStatusSchema,
  pinned: v.boolean(),
  source: v.picklist(["user", "tool", "extracted"]),
  workspaceId: v.nullable(v.string()),
  sourceDataWorkspaceIds: v.array(v.string()),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  updatedAt: v.pipe(v.string(), v.isoTimestamp()),
});

const memoriesPageSchema = v.object({
  items: v.array(memoryListItemSchema),
  nextCursor: v.nullable(v.string()),
  limit: v.number(),
});

const persistedMemoryResultSchema = v.object({
  id: v.string(),
  type: v.picklist(["created", "existing", "reactivated"]),
});

const updatedMemoryResultSchema = v.object({ id: v.string() });

const workspaceNavigationItemSchema = v.object({
  client: v.nullable(
    v.object({
      displayName: v.string(),
      id: v.string(),
    }),
  ),
  clientId: v.nullable(v.string()),
  color: v.nullable(v.string()),
  id: v.string(),
  lastActivityAt: v.pipe(
    v.string(),
    v.isoTimestamp(),
    v.transform((value) => new Date(value)),
  ),
  name: v.string(),
  reference: v.string(),
  status: v.picklist(["active", "archived", "deleting"]),
});

const workspaceNavigationPageSchema = v.object({
  items: v.array(workspaceNavigationItemSchema),
  limit: v.number(),
  nextCursor: v.nullable(v.string()),
  workspaces: v.array(workspaceNavigationItemSchema),
  workspacesCountLimit: v.number(),
});

export type MemoryScope = v.InferOutput<typeof memoryScopeSchema>;
export type MemoryStatus = v.InferOutput<typeof memoryStatusSchema>;
export type MemoryKind = v.InferOutput<typeof memoryKindSchema>;
export type MemoryListItem = v.InferOutput<typeof memoryListItemSchema>;
export type MemoriesPage = v.InferOutput<typeof memoriesPageSchema>;
export type PersistedMemoryResult = v.InferOutput<
  typeof persistedMemoryResultSchema
>;
export type WorkspaceNavigationItem = v.InferOutput<
  typeof workspaceNavigationItemSchema
>;
export type WorkspaceNavigationPage = v.InferOutput<
  typeof workspaceNavigationPageSchema
>;

type MemoryRequestOptions = {
  body?: object | undefined;
  method?: "GET" | "PATCH" | "POST" | undefined;
  path: `/${string}`;
  signal?: AbortSignal | undefined;
};

const requestMemoryApi = async ({
  body,
  method = "GET",
  path,
  signal,
}: MemoryRequestOptions): Promise<unknown> => {
  const response = await fetchWithTimeout(apiUrl(path), {
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    credentials: "include",
    method,
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw toAPIError({ status: response.status, value: null });
  }

  return await response.json();
};

const parseMemoryResponse = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  payload: unknown,
): v.InferOutput<TSchema> => {
  const parsed = v.safeParse(schema, payload);
  if (!parsed.success) {
    throw toAPIError({ status: 502, value: null });
  }
  return parsed.output;
};

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
}: FetchMemoriesPageOptions): Promise<MemoriesPage> => {
  const searchParams = new URLSearchParams({ limit: String(limit) });
  if (cursor !== null) {
    searchParams.set("cursor", cursor);
  }
  if (scope !== undefined) {
    searchParams.set("scope", scope);
  }
  if (status !== undefined) {
    searchParams.set("status", status);
  }
  if (workspaceId !== undefined) {
    searchParams.set("workspaceId", workspaceId);
  }

  const payload = await requestMemoryApi({
    path: `/memories?${searchParams.toString()}`,
    signal,
  });
  return parseMemoryResponse(memoriesPageSchema, payload);
};

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
): Promise<PersistedMemoryResult> => {
  const payload = await requestMemoryApi({
    body: options,
    method: "POST",
    path: "/memories",
  });
  return parseMemoryResponse(persistedMemoryResultSchema, payload);
};

type CreateFirmMemoryOptions = {
  content: string;
  kind: "preference" | "instruction";
};

export const createFirmMemory = async (
  options: CreateFirmMemoryOptions,
): Promise<PersistedMemoryResult> => {
  const payload = await requestMemoryApi({
    body: options,
    method: "POST",
    path: "/memories/firm",
  });
  return parseMemoryResponse(persistedMemoryResultSchema, payload);
};

type UpdateMemoryOptions = {
  body: {
    content?: string | undefined;
    pinned?: boolean | undefined;
    status?: "active" | "archived" | undefined;
  };
  memoryId: string;
};

export const updateMemory = async ({
  body,
  memoryId,
}: UpdateMemoryOptions): Promise<{ id: string }> => {
  const payload = await requestMemoryApi({
    body,
    method: "PATCH",
    path: `/memories/${encodeURIComponent(memoryId)}`,
  });
  return parseMemoryResponse(updatedMemoryResultSchema, payload);
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
}: FetchWorkspaceNavigationPageArgs): Promise<WorkspaceNavigationPage> => {
  const searchParams = new URLSearchParams({ statusScope });
  if (cursor !== undefined) {
    searchParams.set("cursor", cursor);
  }
  if (limit !== undefined) {
    searchParams.set("limit", String(limit));
  }

  const payload = await requestMemoryApi({
    path: `/workspaces/navigation?${searchParams.toString()}`,
    signal,
  });
  return parseMemoryResponse(workspaceNavigationPageSchema, payload);
};
