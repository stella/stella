import { and, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  PENDING_UPLOAD_RECOVERABLE_STATUSES,
  pendingUploads,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
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

/** Reason stamped on a lease that a deletion cancelled. */
const DELETION_REJECT_REASON = "Workspace deletion cancelled the upload";

/**
 * Cancel every still-recoverable upload lease in the given matters.
 *
 * A deletion enumerates the objects it must erase. A writer holding a lease
 * can publish after that read, so its object would survive with no row naming
 * it. This compare-and-set invalidates the writer's claim first: its finalize
 * requires the original claim, and a writer that publishes anyway deletes the
 * reserved object on its own failed-persistence path.
 *
 * `claimedAt` is reset rather than the row removed so a bounded repair can
 * still reach it if object cleanup fails and the matter is reactivated.
 */
export const cancelRecoverableUploads = async (
  tx: Transaction,
  workspaceIds: readonly SafeId<"workspace">[],
): Promise<void> => {
  if (workspaceIds.length === 0) {
    return;
  }
  // audit: skip — internal upload-lease cancellation inside an audited
  // deletion; the user-visible DELETE event is recorded by the caller.
  await tx
    .update(pendingUploads)
    .set({
      claimedAt: new Date(0),
      claimedByRequestId: null,
      rejectReason: DELETION_REJECT_REASON,
      status: "failed",
    })
    .where(
      and(
        inArray(pendingUploads.workspaceId, [...workspaceIds]),
        inArray(pendingUploads.status, PENDING_UPLOAD_RECOVERABLE_STATUSES),
      ),
    );
};
