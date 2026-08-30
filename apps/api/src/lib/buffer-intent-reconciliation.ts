import { Result, TaggedError, panic } from "better-result";
import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  pendingUploads,
  PENDING_UPLOAD_RECOVERABLE_STATUSES,
  workspaces,
} from "@/api/db/schema";
import type { PendingUploadPurposeData } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { LIMITS } from "@/api/lib/limits";
import {
  deleteS3ObjectWithSignal,
  S3_OBJECT_WRITE_CERTAINTY,
} from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

export const BUFFER_INTENT_TTL_MS = 5 * 60 * 1000;
export const BUFFER_INTENT_STALE_MS = 60 * 1000;
export const BUFFER_INTENT_HEARTBEAT_MS = 15 * 1000;
const BUFFER_INTENT_RECONCILE_LIMIT = 25;
export const BUFFER_INTENT_DELETE_TIMEOUT_MS = 30 * 1000;
export const BUFFER_INTENT_WRITE_TIMEOUT_MS = 2 * 60 * 1000;
export const OBJECT_WRITE_RECOVERY_DELAY_MS = BUFFER_INTENT_WRITE_TIMEOUT_MS;
const BUFFER_CLEANUP_RETRY_MAX_EXPONENT = 14;
// A timed-out PUT is bounded to two minutes, but a provider may finish an
// accepted request after the client aborts. Eleven retry windows
// keep exact-key deletion active for more than a day before retirement.
export const BUFFER_INTENT_RECOVERY_RETIRE_AFTER_ATTEMPTS = 11;

export const OBJECT_INTENT_WORKSPACE_AVAILABILITY = {
  ACTIVE: "active",
  NOT_DELETING: "not-deleting",
} as const;

type ObjectIntentWorkspaceAvailability =
  (typeof OBJECT_INTENT_WORKSPACE_AVAILABILITY)[keyof typeof OBJECT_INTENT_WORKSPACE_AVAILABILITY];

export type BufferIntentPurpose = "entity_create" | "entity_version";

export type BufferIntent = {
  claimRequestId: string;
  id: SafeId<"pendingUpload">;
};

type BufferIntentPurposeData =
  | {
      purpose: "entity_create";
      purposeData: Extract<PendingUploadPurposeData, { type: "entity_create" }>;
    }
  | {
      purpose: "entity_version";
      purposeData: Extract<
        PendingUploadPurposeData,
        { type: "entity_version" }
      >;
    };

type ReserveBufferIntentOptions = BufferIntentPurposeData & {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
};

type BufferIntentTelemetryStages = {
  abandon: string;
  heartbeat: string;
  heartbeatUnhandled: string;
};

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

class BufferIntentWorkspaceUnavailableError extends TaggedError(
  "BufferIntentWorkspaceUnavailableError",
)<{ message: string }> {}

export const isBufferIntentWorkspaceUnavailableError = (error: unknown) =>
  BufferIntentWorkspaceUnavailableError.is(error);

class BufferIntentOwnershipError extends TaggedError(
  "BufferIntentOwnershipError",
)<{ message: string }> {}

const organizationObjectIntentLockKey = (
  organizationId: SafeId<"organization">,
): string => `buffer-object:${organizationId}`;

export const lockOrganizationObjectIntentsForWriter = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext(${organizationObjectIntentLockKey(organizationId)}))`,
  );
};

export const lockOrganizationObjectIntentsForLifecycle = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${organizationObjectIntentLockKey(organizationId)}))`,
  );
};

/**
 * Share-lock the workspace while reserving an intent. Workspace deletion
 * takes an update lock before sealing, so either the reservation commits in
 * time for its cleanup snapshot or it observes the seal and cannot publish.
 */
export const lockActiveWorkspaceForBufferIntent = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  const rows = await tx
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("share")
    .limit(1);
  if (rows.at(0)?.status !== "active") {
    throw new BufferIntentWorkspaceUnavailableError({
      message: "Workspace is not active",
    });
  }
};

/** Reserve exact-key recovery ownership before a non-upload writer calls PUT. */
export const reserveObjectCleanupIntents = async ({
  chatThreadId,
  objectKey,
  organizationId,
  safeDb,
  workspaceAvailability = OBJECT_INTENT_WORKSPACE_AVAILABILITY.ACTIVE,
  workspaceIds,
}: {
  chatThreadId?: SafeId<"chatThread">;
  objectKey: string;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  workspaceAvailability?: ObjectIntentWorkspaceAvailability;
  workspaceIds: SafeId<"workspace">[];
}): Promise<Result<SafeId<"pendingUpload">[], SafeDbError>> => {
  const uniqueWorkspaceIds = [...new Set(workspaceIds)].sort();
  const intents =
    uniqueWorkspaceIds.length === 0
      ? [{ id: createSafeId<"pendingUpload">(), ownerWorkspaceId: null }]
      : uniqueWorkspaceIds.map((candidate) => ({
          id: createSafeId<"pendingUpload">(),
          ownerWorkspaceId: candidate,
        }));
  const result = await safeDb(async (tx) => {
    await lockOrganizationObjectIntentsForWriter(tx, organizationId);

    if (uniqueWorkspaceIds.length > 0) {
      const lockedWorkspaces = await tx
        .select({ id: workspaces.id, status: workspaces.status })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.organizationId, organizationId),
            inArray(workspaces.id, uniqueWorkspaceIds),
          ),
        )
        .orderBy(asc(workspaces.id))
        .limit(LIMITS.workspacesCount)
        .for("share");
      if (
        lockedWorkspaces.length !== uniqueWorkspaceIds.length ||
        lockedWorkspaces.some(({ status }) =>
          workspaceAvailability === OBJECT_INTENT_WORKSPACE_AVAILABILITY.ACTIVE
            ? status !== "active"
            : status === "deleting",
        )
      ) {
        throw new BufferIntentWorkspaceUnavailableError({
          message: "Workspace is not active",
        });
      }
    }
    // audit: skip; crash-recovery ownership for the later audited mutation.
    await tx.insert(bufferObjectCleanupIntents).values(
      intents.map(({ id, ownerWorkspaceId }) => ({
        chatThreadId: chatThreadId ?? null,
        id,
        nextAttemptAt: new Date(Date.now() + OBJECT_WRITE_RECOVERY_DELAY_MS),
        objectKey,
        organizationId,
        status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
        workspaceId: ownerWorkspaceId,
      })),
    );
  });
  return Result.isError(result)
    ? Result.err(result.error)
    : Result.ok(intents.map(({ id }) => id));
};

export const reserveObjectCleanupIntent = async ({
  objectKey,
  organizationId,
  safeDb,
  workspaceId,
}: {
  objectKey: string;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
}): Promise<Result<SafeId<"pendingUpload">, SafeDbError>> => {
  const result = await reserveObjectCleanupIntents({
    objectKey,
    organizationId,
    safeDb,
    workspaceIds: [workspaceId],
  });
  return Result.isError(result)
    ? Result.err(result.error)
    : Result.ok(
        result.value.at(0) ?? panic("Object intent insert returned no row"),
      );
};

/** Keep recovery from deleting an exact key while its writer still owns PUT. */
export const lockObjectCleanupIntentsForWriter = async (
  tx: Transaction,
  intentIds: SafeId<"pendingUpload">[],
): Promise<void> => {
  const uniqueIntentIds = [...new Set(intentIds)];
  if (uniqueIntentIds.length === 0) {
    return;
  }
  const rows = await tx
    .select({
      id: bufferObjectCleanupIntents.id,
      status: bufferObjectCleanupIntents.status,
    })
    .from(bufferObjectCleanupIntents)
    .where(inArray(bufferObjectCleanupIntents.id, uniqueIntentIds))
    .for("update");
  if (
    rows.length !== uniqueIntentIds.length ||
    rows.some(
      ({ status }) => status !== BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
    )
  ) {
    throw new BufferIntentOwnershipError({
      message: "Object cleanup ownership was lost before publication",
    });
  }
};

export type ObjectWriterSettlement =
  | "cleanup-required"
  | "object-deleted"
  | "write-uncertain";

export const objectWriterSettlementAfterCleanup = ({
  cleanupSucceeded,
  writeState,
}: {
  cleanupSucceeded: boolean;
  writeState: S3ObjectWriteCertainty;
}): ObjectWriterSettlement => {
  if (writeState === S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN) {
    return "write-uncertain";
  }
  return cleanupSucceeded ? "object-deleted" : "cleanup-required";
};

const UNRETIRED_OBJECT_WRITER_SETTLEMENT_STATUS = {
  "cleanup-required": BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
  "write-uncertain": BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
} as const satisfies Record<
  Exclude<ObjectWriterSettlement, "object-deleted">,
  (typeof BUFFER_OBJECT_CLEANUP_INTENT_STATUS)[keyof typeof BUFFER_OBJECT_CLEANUP_INTENT_STATUS]
>;

// Lifecycle teardown and stale-write recovery may preempt publication by
// moving a live writer to recovery. The authenticated writer still owns final
// settlement, but publication locking remains restricted to WRITING above.
const OBJECT_WRITER_SETTLEMENT_SOURCE_STATUSES = [
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
] as const;

export const settleObjectCleanupIntentsAfterWriterInTransaction = async ({
  intentIds,
  objectState,
  tx,
}: {
  intentIds: SafeId<"pendingUpload">[];
  objectState: ObjectWriterSettlement;
  tx: Transaction;
}): Promise<void> => {
  const uniqueIntentIds = [...new Set(intentIds)];
  if (uniqueIntentIds.length === 0) {
    return;
  }
  if (objectState === "object-deleted") {
    // audit: skip; original-writer crash-recovery ownership settlement only.
    const deleted = await tx
      .delete(bufferObjectCleanupIntents)
      .where(
        and(
          inArray(bufferObjectCleanupIntents.id, uniqueIntentIds),
          inArray(
            bufferObjectCleanupIntents.status,
            OBJECT_WRITER_SETTLEMENT_SOURCE_STATUSES,
          ),
        ),
      )
      .returning({ id: bufferObjectCleanupIntents.id });
    if (deleted.length !== uniqueIntentIds.length) {
      throw new BufferIntentOwnershipError({
        message: "Object cleanup settlement ownership was lost",
      });
    }
    return;
  }
  // audit: skip; exact-key cleanup still needs durable recovery, either because
  // deletion failed or because a timed-out PUT may still complete later.
  const stateUpdate =
    objectState === "write-uncertain"
      ? {
          attemptCount: 0,
          nextAttemptAt: new Date(),
          status: UNRETIRED_OBJECT_WRITER_SETTLEMENT_STATUS[objectState],
        }
      : {
          status: UNRETIRED_OBJECT_WRITER_SETTLEMENT_STATUS[objectState],
        };
  const updated = await tx
    .update(bufferObjectCleanupIntents)
    .set(stateUpdate)
    .where(
      and(
        inArray(bufferObjectCleanupIntents.id, uniqueIntentIds),
        inArray(
          bufferObjectCleanupIntents.status,
          OBJECT_WRITER_SETTLEMENT_SOURCE_STATUSES,
        ),
      ),
    )
    .returning({ id: bufferObjectCleanupIntents.id });
  if (updated.length !== uniqueIntentIds.length) {
    throw new BufferIntentOwnershipError({
      message: "Object cleanup settlement ownership was lost",
    });
  }
};

/** Retire exact-key recovery ownership in the transaction that publishes it. */
export const retirePublishedObjectCleanupIntentsInTransaction = async ({
  intentIds,
  tx,
}: {
  intentIds: SafeId<"pendingUpload">[];
  tx: Transaction;
}): Promise<void> =>
  await settleObjectCleanupIntentsAfterWriterInTransaction({
    intentIds,
    objectState: "object-deleted",
    tx,
  });

/** Settle recovery ownership after the original writer can no longer publish.
 * Successful exact-key deletion retires the proof only after a confirmed PUT.
 * A failed deletion becomes a writer-free orphan; an ambiguous PUT stays in
 * recovery through the late-write quarantine because it may still complete
 * after the writer returns. */
export const settleObjectCleanupIntentsAfterWriter = async ({
  intentIds,
  objectState,
  safeDb,
}: {
  intentIds: SafeId<"pendingUpload">[];
  objectState: ObjectWriterSettlement;
  safeDb: SafeDb;
}): Promise<Result<void, SafeDbError>> => {
  if (intentIds.length === 0) {
    return Result.ok(undefined);
  }
  return await safeDb(
    async (tx) =>
      await settleObjectCleanupIntentsAfterWriterInTransaction({
        intentIds,
        objectState,
        tx,
      }),
  );
};

type ReleaseObjectCleanupIntentScope =
  | {
      organizationId: SafeId<"organization">;
      type: "organization";
    }
  | {
      organizationId: SafeId<"organization">;
      type: "workspace";
      workspaceId: SafeId<"workspace">;
    };

/** Transfer every in-flight exact key in a lifecycle scope to recovery. */
export const releaseObjectCleanupIntentsForLifecycle = async (
  tx: Transaction,
  scope: ReleaseObjectCleanupIntentScope,
): Promise<void> => {
  await tx
    .update(bufferObjectCleanupIntents)
    .set({
      attemptCount: 0,
      nextAttemptAt: new Date(),
      status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
    })
    .where(
      and(
        scope.type === "workspace"
          ? and(
              eq(
                bufferObjectCleanupIntents.organizationId,
                scope.organizationId,
              ),
              eq(bufferObjectCleanupIntents.workspaceId, scope.workspaceId),
            )
          : eq(bufferObjectCleanupIntents.organizationId, scope.organizationId),
        eq(
          bufferObjectCleanupIntents.status,
          BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
        ),
      ),
    );
};

/** Reserve the final object key before a trusted server-side writer publishes. */
export const reserveBufferIntent = async ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  purpose,
  purposeData,
  fileName,
  mimeType,
  sizeBytes,
  sha256Hex,
}: ReserveBufferIntentOptions): Promise<BufferIntent> => {
  const id = createSafeId<"pendingUpload">();
  const claimRequestId = Bun.randomUUIDv7().slice(0, 64);
  const now = new Date();
  const reserved = await safeDb(async (tx) => {
    await lockActiveWorkspaceForBufferIntent(tx, workspaceId);
    // audit: skip — crash-recovery intent; the durable entity mutation is
    // audited in the transaction that finalizes this row.
    const rows = await tx
      .insert(pendingUploads)
      .values({
        id,
        organizationId,
        workspaceId,
        userId,
        purpose,
        purposeData,
        declaredName: fileName,
        declaredMime: mimeType,
        declaredSize: sizeBytes,
        declaredSha256: sha256Hex,
        status: "scanning",
        claimedAt: now,
        claimedByRequestId: claimRequestId,
        expiresAt: new Date(now.getTime() + BUFFER_INTENT_TTL_MS),
        createdAt: now,
      })
      .returning({ id: pendingUploads.id });
    return rows.at(0)?.id ?? panic("Buffer intent insert returned no row");
  });
  if (Result.isError(reserved)) {
    throw reserved.error;
  }
  return { id: reserved.value, claimRequestId };
};

/** Close a recoverable intent only after its exact object key was deleted. */
export const abandonBufferIntent = async ({
  safeDb,
  intent,
  reason,
  telemetry,
}: {
  safeDb: SafeDb;
  intent: BufferIntent;
  reason: string;
  telemetry: BufferIntentTelemetryStages;
}): Promise<void> => {
  const abandoned = await safeDb(async (tx) => {
    // audit: skip — failed intent bookkeeping; no durable entity mutation.
    // The writer reaches this only after its PUT settled and deletion of its
    // exact reserved key succeeded, even if a reconciler replaced its lease.
    await tx
      .update(pendingUploads)
      .set({
        finalizedAt: new Date(),
        rejectReason: reason,
        status: "rejected",
      })
      .where(
        and(
          eq(pendingUploads.id, intent.id),
          inArray(pendingUploads.status, PENDING_UPLOAD_RECOVERABLE_STATUSES),
        ),
      );
    await tx
      .delete(bufferObjectCleanupIntents)
      .where(eq(bufferObjectCleanupIntents.id, intent.id));
  });
  if (Result.isError(abandoned)) {
    captureError(abandoned.error, {
      pendingUploadId: intent.id,
      stage: telemetry.abandon,
    });
  }
};

/** Renew one writer's recovery lease until its storage/DB work settles. */
export const startBufferIntentHeartbeat = ({
  safeDb,
  intent,
  telemetry,
}: {
  safeDb: SafeDb;
  intent: BufferIntent;
  telemetry: BufferIntentTelemetryStages;
}): (() => Promise<void>) => {
  let heartbeatPromise: Promise<void> | null = null;
  let stopped = false;
  const heartbeat = async (): Promise<void> => {
    try {
      const renewed = await safeDb(async (tx) => {
        // audit: skip — live crash-recovery lease bookkeeping only.
        await tx
          .update(pendingUploads)
          .set({ claimedAt: new Date() })
          .where(
            and(
              eq(pendingUploads.id, intent.id),
              eq(pendingUploads.status, "scanning"),
              eq(pendingUploads.claimedByRequestId, intent.claimRequestId),
            ),
          );
      });
      if (Result.isError(renewed)) {
        captureError(renewed.error, {
          pendingUploadId: intent.id,
          stage: telemetry.heartbeat,
        });
      }
    } catch (error) {
      captureError(error, {
        pendingUploadId: intent.id,
        stage: telemetry.heartbeatUnhandled,
      });
    } finally {
      heartbeatPromise = null;
    }
  };
  const triggerHeartbeat = (): void => {
    if (heartbeatPromise !== null || stopped) {
      return;
    }
    heartbeatPromise = heartbeat();
  };
  const timer = setInterval(triggerHeartbeat, BUFFER_INTENT_HEARTBEAT_MS);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeatPromise;
  };
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
        status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
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
 * Retry exact-key cleanup with exponential backoff. Writer-free orphan rows
 * retire after confirmed deletion. Recovery rows survive a full late-write
 * quarantine, then retire only after one final confirmed deletion.
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
        status: bufferObjectCleanupIntents.status,
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
            ${BUFFER_CLEANUP_RETRY_MAX_EXPONENT}::integer
          )) * interval '1 minute',
          interval '24 hours'
        )`,
        status: sql`CASE
          WHEN ${bufferObjectCleanupIntents.status} = ${BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING}
            THEN ${BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING}
          ELSE ${bufferObjectCleanupIntents.status}
        END`,
      })
      .where(inArray(bufferObjectCleanupIntents.id, ids));
    return rows;
  });
  if (Result.isError(claimedResult)) {
    throw claimedResult.error;
  }

  const cleanupResults = await Promise.all(
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
      if (Result.isError(cleanup)) {
        return null;
      }
      if (row.status === BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED) {
        return row.id;
      }
      if (
        row.status === BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING &&
        row.attemptCount >= BUFFER_INTENT_RECOVERY_RETIRE_AFTER_ATTEMPTS
      ) {
        return row.id;
      }
      return null;
    }),
  );
  signal?.throwIfAborted();
  const retiredIds = cleanupResults.filter(
    (id): id is SafeId<"pendingUpload"> => id !== null,
  );
  if (retiredIds.length > 0) {
    const retired = await safeDb(async (tx) => {
      // audit: skip; terminal cleanup bookkeeping after exact-key deletion.
      await tx
        .delete(bufferObjectCleanupIntents)
        .where(
          and(
            inArray(bufferObjectCleanupIntents.id, retiredIds),
            ne(
              bufferObjectCleanupIntents.status,
              BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
            ),
          ),
        );
    });
    if (Result.isError(retired)) {
      throw retired.error;
    }
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
