import { Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { pendingUploads } from "@/api/db/schema";
import type { PendingUploadPurposeData } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-keys";
import { getS3 } from "@/api/lib/s3";

export const BUFFER_INTENT_TTL_MS = 5 * 60 * 1000;
export const BUFFER_INTENT_STALE_MS = 60 * 1000;
export const BUFFER_INTENT_HEARTBEAT_MS = 15 * 1000;
const BUFFER_INTENT_RECONCILE_LIMIT = 25;

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
}: {
  safeDb: SafeDb;
  scope?: BufferIntentScope | undefined;
  limit: number;
}): Promise<number> => {
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
        sql`${ownershipPredicate}
          AND ${pendingUploads.purposeData}->>'reservedFileId' IS NOT NULL
          AND ${pendingUploads.status} = 'scanning'
          AND ${pendingUploads.claimedAt} < NOW() - ${timeoutSeconds} * interval '1 second'`,
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
      })
      .where(
        and(
          inArray(pendingUploads.id, ids),
          eq(pendingUploads.status, "scanning"),
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
        try: async () => await getS3().delete(objectKey),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup)) {
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
  const cleanedIds = cleanupResults.filter(
    (id): id is SafeId<"pendingUpload"> => id !== null,
  );
  if (cleanedIds.length === 0) {
    return claimedResult.value.length;
  }

  const finalizedCleanup = await safeDb(async (tx) => {
    // audit: skip — terminal crash-recovery bookkeeping after object cleanup.
    await tx
      .update(pendingUploads)
      .set({
        finalizedAt: new Date(),
        rejectReason: sql<string>`CASE
          WHEN ${pendingUploads.purpose} = 'entity_create'
            THEN ${rejectionReason("entity_create")}
          ELSE ${rejectionReason("entity_version")}
        END`,
        status: "rejected",
      })
      .where(
        and(
          inArray(pendingUploads.id, cleanedIds),
          eq(pendingUploads.status, "scanning"),
          eq(pendingUploads.claimedByRequestId, reconcileClaimId),
        ),
      );
  });
  if (Result.isError(finalizedCleanup)) {
    captureError(finalizedCleanup.error, {
      pendingUploadIds: cleanedIds.join(","),
      stage: "buffer-intent-reconcile-finalize",
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
}: {
  safeDb: SafeDb;
  limit: number;
}): Promise<number> => await reconcileStaleBufferIntentBatch({ safeDb, limit });
