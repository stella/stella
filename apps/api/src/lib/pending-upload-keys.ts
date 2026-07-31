import type { pendingUploads } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { tmpUploadKeys } from "@/api/handlers/uploads/lib";
import {
  isBufferIntentPurpose,
  isRecoverableBufferIntent,
} from "@/api/lib/buffer-intent-reconciliation";

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
  if (
    isBufferIntentPurpose(row.purpose) &&
    isRecoverableBufferIntent(row.purposeData, row.purpose)
  ) {
    keys.push(
      createFileKey({
        fileId: row.purposeData.reservedFileId,
        mimeType: row.declaredMime,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
      }),
    );
  }
  return keys;
};
