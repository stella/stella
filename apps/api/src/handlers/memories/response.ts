import type { aiMemories } from "@/api/db/schema";

type MemoryResponseRow = Pick<
  typeof aiMemories.$inferSelect,
  | "id"
  | "scope"
  | "kind"
  | "content"
  | "language"
  | "status"
  | "pinned"
  | "source"
  | "workspaceId"
  | "sourceDataWorkspaceIds"
  | "createdAt"
  | "updatedAt"
>;

export const toMemoryResponse = (row: MemoryResponseRow) => ({
  id: row.id,
  scope: row.scope,
  kind: row.kind,
  content: row.content,
  language: row.language,
  status: row.status,
  pinned: row.pinned,
  source: row.source,
  workspaceId: row.workspaceId,
  sourceDataWorkspaceIds: row.sourceDataWorkspaceIds,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
