import type { pendingUploads } from "@/api/db/schema";
import { tmpUploadKeys } from "@/api/handlers/uploads/lib";
import { bufferIntentObjectKey } from "@/api/lib/buffer-intent-reconciliation";

type PendingUploadDeletionRow = Pick<
  typeof pendingUploads.$inferSelect,
  | "declaredMime"
  | "id"
  | "organizationId"
  | "purpose"
  | "purposeData"
  | "workspaceId"
>;

export const pendingUploadS3KeysForDeletion = (
  row: PendingUploadDeletionRow,
): string[] => {
  const keys = tmpUploadKeys({
    organizationId: row.organizationId,
    uploadId: row.id,
    workspaceId: row.workspaceId,
  });
  const objectKey = bufferIntentObjectKey(row);
  if (objectKey !== null) {
    keys.push(objectKey);
  }
  return keys;
};
