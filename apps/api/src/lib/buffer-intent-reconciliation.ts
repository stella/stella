import { Result, TaggedError, panic } from "better-result";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
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
import { mapWithConcurrency } from "@/api/lib/map-with-concurrency";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

export const BUFFER_INTENT_TTL_MS = 5 * 60 * 1000;
export const BUFFER_INTENT_STALE_MS = 60 * 1000;
export const BUFFER_INTENT_HEARTBEAT_MS = 15 * 1000;
const BUFFER_INTENT_RECONCILE_LIMIT = 25;
const RECOVERY_DELETE_CONCURRENCY = 4;
export const BUFFER_INTENT_DELETE_TIMEOUT_MS = 30 * 1000;
export const BUFFER_INTENT_WRITE_TIMEOUT_MS = 2 * 60 * 1000;
const BUFFER_CLEANUP_RETRY_MAX_EXPONENT = 14;

const bufferCleanupIntentIdentityPredicate = (
  rows: Pick<
    typeof bufferObjectCleanupIntents.$inferSelect,
    "id" | "objectKey"
  >[],
) =>
  or(
    ...rows.map(({ id, objectKey }) =>
      and(
        eq(bufferObjectCleanupIntents.id, id),
        eq(bufferObjectCleanupIntents.objectKey, objectKey),
      ),
    ),
  );

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

type RecoverableEmailIngest = Extract<
  PendingUploadPurposeData,
  { type: "email_ingest" }
> & { recoveryObjectKeys: string[] };

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
    .limit(1)
    .for("share");
  if (rows.at(0)?.status !== "active") {
    throw new BufferIntentWorkspaceUnavailableError({
      message: "Workspace is not active",
    });
  }
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

const isRecoverableEmailIngest = (
  value: PendingUploadPurposeData,
): value is RecoverableEmailIngest =>
  value.type === "email_ingest" &&
  Array.isArray(value.recoveryObjectKeys) &&
  value.recoveryObjectKeys.length > 0 &&
  value.recoveryObjectKeys.every(
    (objectKey) => typeof objectKey === "string" && objectKey.length > 0,
  );

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

export const pendingUploadRecoveryObjectKeys = (
  row: BufferIntentDeletionRow,
): string[] => {
  const bufferKey = bufferIntentObjectKey(row);
  if (bufferKey !== null) {
    return [bufferKey];
  }
  if (
    row.purpose === "email_ingest" &&
    isRecoverableEmailIngest(row.purposeData)
  ) {
    return row.purposeData.recoveryObjectKeys;
  }
  return [];
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
  const values = rows.flatMap((row) =>
    pendingUploadRecoveryObjectKeys(row).map((objectKey) => ({
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      objectKey,
    })),
  );
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
      ? sql`${pendingUploads.purpose} IN ('entity_create', 'entity_version', 'email_ingest')`
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
          sql`(
            ${pendingUploads.purposeData}->>'reservedFileId' IS NOT NULL
            OR (
              ${pendingUploads.purpose} = 'email_ingest'
              AND jsonb_array_length(COALESCE(${pendingUploads.purposeData}->'recoveryObjectKeys', '[]'::jsonb)) > 0
            )
          )`,
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

  const cleanupResults = await mapWithConcurrency({
    items: claimedResult.value.flatMap((row) =>
      pendingUploadRecoveryObjectKeys(row).map((objectKey) => ({
        objectKey,
        row,
      })),
    ),
    limit: RECOVERY_DELETE_CONCURRENCY,
    operation: async ({ objectKey, row }) => ({
      result: await Result.tryPromise({
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
      }),
      row,
    }),
  });
  signal?.throwIfAborted();
  const failedIds = new Set<SafeId<"pendingUpload">>();
  for (const { result, row } of cleanupResults) {
    if (!Result.isError(result) || failedIds.has(row.id)) {
      continue;
    }
    failedIds.add(row.id);
    captureError(result.error, {
      pendingUploadId: row.id,
      stage: `buffer-${row.purpose}-intent-reconcile`,
    });
  }
  const cleanedIds = claimedResult.value.flatMap((row) => {
    const hasRecoveryObjects = pendingUploadRecoveryObjectKeys(row).length > 0;
    return hasRecoveryObjects && !failedIds.has(row.id) ? [row.id] : [];
  });
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
          WHEN ${pendingUploads.purpose} = 'entity_version'
            THEN ${rejectionReason("entity_version")}
          ELSE 'Reconciled abandoned email ingest bytes'
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
      })
      .where(bufferCleanupIntentIdentityPredicate(rows));
    return rows;
  });
  if (Result.isError(claimedResult)) {
    throw claimedResult.error;
  }

  await mapWithConcurrency({
    items: claimedResult.value,
    limit: RECOVERY_DELETE_CONCURRENCY,
    operation: async (row) => {
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
    },
  });
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
  // Run both claim classes through one worker-wide deletion budget. Each
  // reconciler bounds its flat object list, and sequencing prevents their
  // independent pools from multiplying storage concurrency.
  const pendingCount = await reconcileStaleBufferIntentBatch({
    safeDb,
    limit: pendingLimit,
    signal,
    deleteObject,
  });
  const transferredCount = await reconcileBufferObjectCleanupIntents({
    safeDb,
    limit: transferredLimit,
    signal,
    deleteObject,
  });
  return pendingCount + transferredCount;
};
