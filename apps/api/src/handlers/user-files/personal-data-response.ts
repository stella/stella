import type { userFiles } from "@/api/db/schema";

// Storage keys and scan metadata remain internal. The archive path is derived
// from the persisted UUID, never from an uploaded filename.
export const toPersonalUserFileResponse = (
  row: typeof userFiles.$inferSelect,
) => ({
  id: row.id,
  threadId: row.threadId,
  fileName: row.fileName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  archivePath: `files/${row.id}`,
  createdAt: row.createdAt.toISOString(),
});
