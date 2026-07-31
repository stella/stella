import { Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  pendingUploads,
  PENDING_UPLOAD_RECOVERABLE_STATUSES,
} from "@/api/db/schema";
import type { PendingUploadPurposeData } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { getS3 } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

export const BUFFER_INTENT_TTL_MS = 5 * 60 * 1000;
export const BUFFER_INTENT_STALE_MS = 60 * 1000;
export const BUFFER_INTENT_HEARTBEAT_MS = 15 * 1000;
const BUFFER_INTENT_RECONCILE_LIMIT = 25;
const BUFFER_INTENT_DELETE_TIMEOUT_MS = 30 * 1000;

export type BufferIntentPurpose = "entity_create" | "entity_version";

type BufferIntentScope = {
  organizationId: SafeId<"organization">;
  purpose: BufferIntentPurpose;
  workspaceId: SafeId<"workspace">;
};

type RecoverableBufferIntent = PendingUploadPurposeData & {
  reservedFileId: string;
  type: BufferIntentPurpose;
};

export const isRecoverableBufferIntent = (
  value: PendingUploadPurposeData,
  purpose: BufferIntentPurpose,
): value is RecoverableBufferIntent =>
  value.type === purpose &&
  "reservedFileId" in value &&
  typeof value.reservedFileId === "string" &&
  value.reservedFileId.length > 0;

const rejectionReason = (purpose: BufferIntentPurpose): string =>
  purpose === "entity_create"
    ? "Reconciled abandoned server-generated entity bytes"
    : "Reconciled abandoned server-generated version bytes";

export const isBufferIntentPurpose = (
  purpose: string,
): purpose is BufferIntentPurpose =>
  purpose === "entity_create" || purpose === "entity_version";

const reconcileStaleBufferIntentBatch = async ({
  safeDb,
  scope,
  limit,
  signal,
}: {
  safeDb: SafeDb;
  scope?: BufferIntentScope | undefined;
  limit: number;
  signal?: AbortSignal | undefined;
}): Promise<number> => {
  signal?.throwIfAborted();
  const reconcileClaimId = Bun.randomUUIDv7().slice(0, 64);
  const timeoutSeconds = Math.floor(BUFFER_INTENT_STALE_MS / 1000);
  const ownershipPredicate =
    scope === undefined
      ? sql`${pendingUploads.purpose} IN ('entity_create', 'entity_version')`
      : sql`${pendingUploads.organizationId} = ${scope.organizationId}
          AND ${pendingUploads.workspaceId} = ${scope.workspaceId}
          AND ${pendingUploads.purpose} = ${scope.purpose}`;
  const claimedResult = await safeDb(async (tx) => {
    const staleRows = await tx
      .select({
        declaredMime: pendingUploads.declaredMime,
        id: pendingUploads.id,
        organizationId: pendingUploads.organizationId,
        purpose: pendingUploads.purpose,
        purposeData: pendingUploads.purposeData,
        workspaceId: pendingUploads.workspaceId,
      })
      .from(pendingUploads)
      .where(
        and(
          ownershipPredicate,
          sql`${pendingUploads.purposeData}->>'reservedFileId' IS NOT NULL`,
          inArray(pendingUploads.status, PENDING_UPLOAD_RECOVERABLE_STATUSES),
          sql`${pendingUploads.claimedAt} < NOW() - ${timeoutSeconds} * interval '1 second'`,
        ),
      )
      .orderBy(asc(pendingUploads.claimedAt), asc(pendingUploads.id))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (staleRows.length === 0) {
      return [];
    }

    const ids = staleRows.map((row) => row.id);
    // audit: skip — crash-recovery claim bookkeeping; no entity changes.
    await tx
      .update(pendingUploads)
      .set({
        claimedAt: new Date(),
        claimedByRequestId: reconcileClaimId,
        status: "scanning",
      })
      .where(
        and(
          inArray(pendingUploads.id, ids),
          inArray(pendingUploads.status, PENDING_UPLOAD_RECOVERABLE_STATUSES),
        ),
      );
    return staleRows;
  });
  if (Result.isError(claimedResult)) {
    throw claimedResult.error;
  }

  const cleanupResults = await Promise.all(
    claimedResult.value.map(async (row) => {
      if (
        !isBufferIntentPurpose(row.purpose) ||
        !isRecoverableBufferIntent(row.purposeData, row.purpose)
      ) {
        return null;
      }
      const objectKey = createFileKey({
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        fileId: row.purposeData.reservedFileId,
        mimeType: row.declaredMime,
      });
      const cleanup = await Result.tryPromise({
        try: async () =>
          await withTimeout(async () => await getS3().delete(objectKey), {
            label: "buffer-intent-reconciliation.delete",
            signal,
            timeoutMs: BUFFER_INTENT_DELETE_TIMEOUT_MS,
          }),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup)) {
        if (signal?.aborted) {
          return null;
        }
        captureError(cleanup.error, {
          objectKey,
          pendingUploadId: row.id,
          stage: `buffer-${row.purpose}-intent-reconcile`,
        });
        return null;
      }
      return row.id;
    }),
  );
  signal?.throwIfAborted();
  const cleanedIds = cleanupResults.filter(
    (id): id is SafeId<"pendingUpload"> => id !== null,
  );
  if (cleanedIds.length === 0) {
    return claimedResult.value.length;
  }

  const retainedCleanup = await safeDb(async (tx) => {
    // audit: skip — durable crash-recovery retry bookkeeping; no entity changes.
    // A reclaimed writer may still publish after this delete. Keep the row
    // recoverable so later sweeps delete any late object publication. A writer
    // that eventually settles can terminalize the row after its own confirmed
    // cleanup.
    await tx
      .update(pendingUploads)
      .set({
        claimedAt: new Date(),
        rejectReason: sql<string>`CASE
          WHEN ${pendingUploads.purpose} = 'entity_create'
            THEN ${rejectionReason("entity_create")}
          ELSE ${rejectionReason("entity_version")}
        END`,
        status: "failed",
      })
      .where(
        and(
          inArray(pendingUploads.id, cleanedIds),
          eq(pendingUploads.status, "scanning"),
          eq(pendingUploads.claimedByRequestId, reconcileClaimId),
        ),
      );
  });
  if (Result.isError(retainedCleanup)) {
    captureError(retainedCleanup.error, {
      pendingUploadIds: cleanedIds.join(","),
      stage: "buffer-intent-reconcile-retain",
    });
  }
  return claimedResult.value.length;
};

/**
 * Claim and remove one bounded workspace batch of final-key objects whose
 * durable intent proves that no entity/version transaction committed. The
 * intent is finalized atomically with the reference, so a committed object
 * can never satisfy this stale-scanning predicate.
 */
export const reconcileStaleBufferIntents = async ({
  safeDb,
  organizationId,
  workspaceId,
  purpose,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  purpose: BufferIntentPurpose;
}): Promise<void> => {
  await reconcileStaleBufferIntentBatch({
    safeDb,
    scope: { organizationId, workspaceId, purpose },
    limit: BUFFER_INTENT_RECONCILE_LIMIT,
  });
};

/**
 * Fair global scheduler entrypoint. It claims the oldest stale rows directly,
 * rather than rediscovering a fixed prefix of tenant scopes. Every attempted
 * cleanup advances `claimedAt`, so a persistently failing object rotates behind
 * older untouched rows and cannot starve the rest of the table.
 */
export const reconcileStaleBufferIntentsGlobally = async ({
  safeDb,
  limit,
  signal,
}: {
  safeDb: SafeDb;
  limit: number;
  signal?: AbortSignal | undefined;
}): Promise<number> =>
  await reconcileStaleBufferIntentBatch({ safeDb, limit, signal });
