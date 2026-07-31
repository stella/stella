import { Result } from "better-result";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  bufferObjectCleanupIntents,
  pendingUploads,
  PENDING_UPLOAD_RECOVERABLE_STATUSES,
} from "@/api/db/schema";
import type { PendingUploadPurposeData } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

export const BUFFER_INTENT_TTL_MS = 5 * 60 * 1000;
export const BUFFER_INTENT_STALE_MS = 60 * 1000;
export const BUFFER_INTENT_HEARTBEAT_MS = 15 * 1000;
const BUFFER_INTENT_RECONCILE_LIMIT = 25;
const BUFFER_INTENT_DELETE_TIMEOUT_MS = 30 * 1000;
const BUFFER_CLEANUP_RETRY_MAX_EXPONENT = 14;

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

type BufferIntentDeletionRow = Pick<
  typeof pendingUploads.$inferSelect,
  | "declaredMime"
  | "id"
  | "organizationId"
  | "purpose"
  | "purposeData"
  | "workspaceId"
>;

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

export const bufferIntentObjectKey = (
  row: BufferIntentDeletionRow,
): string | null => {
  if (
    !isBufferIntentPurpose(row.purpose) ||
    !isRecoverableBufferIntent(row.purposeData, row.purpose)
  ) {
    return null;
  }
  return createFileKey({
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    fileId: row.purposeData.reservedFileId,
    mimeType: row.declaredMime,
  });
};

/**
 * Transfer final-key cleanup ownership before lifecycle cascades remove the
 * pending-upload row. The tombstone has no user/workspace foreign keys, so a
 * dead writer can never erase the last durable recovery record.
 */
export const preserveBufferObjectCleanupIntents = async (
  tx: Transaction,
  rows: BufferIntentDeletionRow[],
): Promise<void> => {
  const values = rows.flatMap((row) => {
    const objectKey = bufferIntentObjectKey(row);
    if (objectKey === null) {
      return [];
    }
    return [
      {
        id: row.id,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        objectKey,
      },
    ];
  });
  if (values.length === 0) {
    return;
  }
  // audit: skip — storage recovery ownership transfer only.
  await tx
    .insert(bufferObjectCleanupIntents)
    .values(values)
    .onConflictDoNothing();
};

const reconcileStaleBufferIntentBatch = async ({
  safeDb,
  scope,
  limit,
  signal,
  deleteObject = deleteS3ObjectWithSignal,
}: {
  safeDb: SafeDb;
  scope?: BufferIntentScope | undefined;
  limit: number;
  signal?: AbortSignal | undefined;
  deleteObject?: typeof deleteS3ObjectWithSignal;
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
          await withTimeout(
            async (operationSignal) =>
              await deleteObject(objectKey, operationSignal),
            {
              label: "buffer-intent-reconciliation.delete",
              signal,
              timeoutMs: BUFFER_INTENT_DELETE_TIMEOUT_MS,
            },
          ),
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
 * Retry lifecycle-transferred keys indefinitely with exponential backoff.
 * Only the original writer may remove a tombstone after its PUT has settled
 * and deletion of the exact key succeeds.
 */
export const reconcileBufferObjectCleanupIntents = async ({
  safeDb,
  limit,
  signal,
  deleteObject = deleteS3ObjectWithSignal,
}: {
  safeDb: SafeDb;
  limit: number;
  signal?: AbortSignal | undefined;
  deleteObject?: typeof deleteS3ObjectWithSignal;
}): Promise<number> => {
  if (limit === 0) {
    return 0;
  }
  signal?.throwIfAborted();
  const claimedResult = await safeDb(async (tx) => {
    const rows = await tx
      .select({
        attemptCount: bufferObjectCleanupIntents.attemptCount,
        id: bufferObjectCleanupIntents.id,
        objectKey: bufferObjectCleanupIntents.objectKey,
      })
      .from(bufferObjectCleanupIntents)
      .where(lte(bufferObjectCleanupIntents.nextAttemptAt, new Date()))
      .orderBy(
        asc(bufferObjectCleanupIntents.nextAttemptAt),
        asc(bufferObjectCleanupIntents.id),
      )
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map(({ id }) => id);
    // audit: skip — bounded durable cleanup retry bookkeeping only.
    await tx
      .update(bufferObjectCleanupIntents)
      .set({
        attemptCount: sql`${bufferObjectCleanupIntents.attemptCount} + 1`,
        nextAttemptAt: sql`NOW() + LEAST(
          POWER(2, LEAST(
            ${bufferObjectCleanupIntents.attemptCount},
            ${BUFFER_CLEANUP_RETRY_MAX_EXPONENT}
          )) * interval '1 minute',
          interval '24 hours'
        )`,
      })
      .where(inArray(bufferObjectCleanupIntents.id, ids));
    return rows;
  });
  if (Result.isError(claimedResult)) {
    throw claimedResult.error;
  }

  await Promise.all(
    claimedResult.value.map(async (row) => {
      const cleanup = await Result.tryPromise({
        try: async () =>
          await withTimeout(
            async (operationSignal) =>
              await deleteObject(row.objectKey, operationSignal),
            {
              label: "buffer-object-cleanup.delete",
              signal,
              timeoutMs: BUFFER_INTENT_DELETE_TIMEOUT_MS,
            },
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup) && !signal?.aborted) {
        captureError(cleanup.error, {
          pendingUploadId: row.id,
          stage: "buffer-object-cleanup-reconcile",
        });
      }
    }),
  );
  signal?.throwIfAborted();
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
  deleteObject = deleteS3ObjectWithSignal,
}: {
  safeDb: SafeDb;
  limit: number;
  signal?: AbortSignal | undefined;
  deleteObject?: typeof deleteS3ObjectWithSignal;
}): Promise<number> => {
  const pendingLimit = Math.ceil(limit / 2);
  const transferredLimit = Math.floor(limit / 2);
  const [pendingCount, transferredCount] = await Promise.all([
    reconcileStaleBufferIntentBatch({
      safeDb,
      limit: pendingLimit,
      signal,
      deleteObject,
    }),
    reconcileBufferObjectCleanupIntents({
      safeDb,
      limit: transferredLimit,
      signal,
      deleteObject,
    }),
  ]);
  return pendingCount + transferredCount;
};
