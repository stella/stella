import type { aiMemories } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

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

// The guard runs against the full table row, not the narrowed input above, so
// a new column must be classified here before it can drift silently.
type AiMemoryRow = typeof aiMemories.$inferSelect;
type MemoryResponse = ReturnType<typeof toMemoryResponse>;

// Columns intentionally not sent to the client (memories list and the
// account export share this response).
const UNPROJECTED_AI_MEMORY_COLUMNS = [
  // Tenant id: the caller already knows its active organization.
  "organizationId",
  // Owner id: `scope` says whose memory it is, and the caller is that owner
  // or a member of the owning organization or matter.
  "userId",
  // Internal idempotency hash over the memory's canonical fields.
  "dedupKey",
  // Extractor provenance and scoring: links into chat history that may be
  // assistant output, and an internal model confidence.
  "sourceMessageId",
  "confidence",
  // Initiating actor id for explicit writes and extractions; `source` says
  // how the memory was created.
  "createdBy",
  // Curator lifecycle bookkeeping; `status` carries the user-visible state.
  "supersededById",
  "lastUsedAt",
  "archivedAt",
] as const satisfies readonly (keyof AiMemoryRow)[];

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedAiMemoryColumn = UnprojectedColumns<
  AiMemoryRow,
  MemoryResponse,
  (typeof UNPROJECTED_AI_MEMORY_COLUMNS)[number]
>;
type UnexpectedProjectedAiMemoryColumn = UnbackedProjectionKeys<
  AiMemoryRow,
  MemoryResponse,
  (typeof UNPROJECTED_AI_MEMORY_COLUMNS)[number]
>;

true satisfies MissingProjectedAiMemoryColumn extends never ? true : never;
true satisfies UnexpectedProjectedAiMemoryColumn extends never ? true : never;
