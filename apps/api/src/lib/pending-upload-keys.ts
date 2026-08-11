import type { pendingUploads } from "@/api/db/schema";
import { pendingUploadRecoveryObjectKeys } from "@/api/lib/buffer-intent-reconciliation";
import { tmpUploadKeys } from "@/api/lib/uploads/runtime";

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
  for (const objectKey of pendingUploadRecoveryObjectKeys(row)) {
    keys.push(objectKey);
  }
  return keys;
};
