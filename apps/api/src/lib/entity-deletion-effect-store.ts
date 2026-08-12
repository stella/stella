import { and, asc, eq, lt, lte, notExists, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  entityDeletionCleanupRequests,
  entityDeletionEffectChunks,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  DESTRUCTIVE_EFFECT_CHUNK_INSERT_BATCH_SIZE,
  DESTRUCTIVE_EFFECT_LEGACY_STALE_PROCESSING_MS,
  assertValidS3DeletionEffectChunk,
  consumeInBatches,
  createS3DeletionEffectChunks,
  getDestructiveEffectRetryAt,
} from "@/api/lib/destructive-effect-chunks";
import { createEffectLease } from "@/api/lib/effect-lease";
import type { EffectLease } from "@/api/lib/effect-lease";

export const ENTITY_DELETION_EFFECT_KIND = "entity-deletion-s3" as const;
export const ENTITY_DELETION_EFFECT_LEASE_MS = 15 * 60_000;
const RECOVERY_STATE_LIMIT = 50;

export type EntityDeletionEffectClaim = {
  attemptCount: number;
  chunkId: SafeId<"entityDeletionEffectChunk">;
  lease: EffectLease<typeof ENTITY_DELETION_EFFECT_KIND>;
  requestId: SafeId<"entityDeletionCleanupRequest">;
  s3Keys: string[];
};

type EntityDeletionEffectDb = Pick<
  typeof rootDb,
  "select" | "selectDistinct" | "transaction"
>;

const eligibleChunkPredicate = () =>
  or(
    eq(entityDeletionEffectChunks.status, "pending"),
    and(
      eq(entityDeletionEffectChunks.status, "failed"),
      sql`${entityDeletionEffectChunks.nextAttemptAt} <= CURRENT_TIMESTAMP`,
    ),
    and(
      eq(entityDeletionEffectChunks.status, "processing"),
      sql`${entityDeletionEffectChunks.leaseExpiresAt} <= CURRENT_TIMESTAMP`,
    ),
  );

const deriveParentStatus = (
  states: ReadonlySet<
    (typeof entityDeletionEffectChunks.$inferSelect)["status"]
  >,
): (typeof entityDeletionCleanupRequests.$inferSelect)["status"] => {
  if (states.has("processing")) {
    return "processing";
  }
  if (states.has("failed")) {
    return "failed";
  }
  if (states.has("pending")) {
    return "pending";
  }
  return "completed";
};

const synchronizeParentProjection = async (
  tx: Transaction,
  requestId: SafeId<"entityDeletionCleanupRequest">,
): Promise<void> => {
  const parent = (
    await tx
      .select({ id: entityDeletionCleanupRequests.id })
      .from(entityDeletionCleanupRequests)
      .where(eq(entityDeletionCleanupRequests.id, requestId))
      .limit(1)
      .for("update")
  ).at(0);
  if (!parent) {
    return;
  }
  const states = await tx
    .selectDistinct({ status: entityDeletionEffectChunks.status })
    .from(entityDeletionEffectChunks)
    .where(eq(entityDeletionEffectChunks.requestId, requestId))
    .limit(4);
  const status = deriveParentStatus(
    new Set(states.map(({ status: chunkStatus }) => chunkStatus)),
  );
  const failed =
    status === "failed"
      ? (
          await tx
            .select({
              errorMessage: entityDeletionEffectChunks.errorMessage,
              nextAttemptAt: entityDeletionEffectChunks.nextAttemptAt,
            })
            .from(entityDeletionEffectChunks)
            .where(
              and(
                eq(entityDeletionEffectChunks.requestId, requestId),
                eq(entityDeletionEffectChunks.status, "failed"),
              ),
            )
            .orderBy(
              asc(entityDeletionEffectChunks.nextAttemptAt),
              asc(entityDeletionEffectChunks.chunkIndex),
            )
            .limit(1)
        ).at(0)
      : undefined;
  await tx
    .update(entityDeletionCleanupRequests)
    .set({
      completedAt: status === "completed" ? new Date() : null,
      errorMessage: failed?.errorMessage ?? null,
      nextAttemptAt: failed?.nextAttemptAt ?? null,
      s3Keys:
        status === "completed"
          ? []
          : sql`${entityDeletionCleanupRequests.s3Keys}`,
      status,
      updatedAt: new Date(),
    })
    .where(eq(entityDeletionCleanupRequests.id, requestId));
};

export const ensureEntityDeletionEffectChunks = async (
  requestId: SafeId<"entityDeletionCleanupRequest">,
  db: EntityDeletionEffectDb = rootDb,
): Promise<number> =>
  await db.transaction(async (tx) => {
    const request = (
      await tx
        .select({ s3Keys: entityDeletionCleanupRequests.s3Keys })
        .from(entityDeletionCleanupRequests)
        .where(eq(entityDeletionCleanupRequests.id, requestId))
        .limit(1)
        .for("update")
    ).at(0);
    if (!request) {
      return 0;
    }
    const existing = (
      await tx
        .select({ id: entityDeletionEffectChunks.id })
        .from(entityDeletionEffectChunks)
        .where(eq(entityDeletionEffectChunks.requestId, requestId))
        .limit(1)
    ).at(0);
    if (existing) {
      return 0;
    }
    const chunks = createS3DeletionEffectChunks(request.s3Keys);
    if (chunks.length > 0) {
      await consumeInBatches({
        batchSize: DESTRUCTIVE_EFFECT_CHUNK_INSERT_BATCH_SIZE,
        consume: async (batch) => {
          // audit: skip — rolling-deploy materialization of the parent
          // deletion intent; the entity deletion already owns the audit event.
          await tx.insert(entityDeletionEffectChunks).values(
            batch.map((chunk) => ({
              chunkIndex: chunk.chunkIndex,
              effectType: chunk.effectType,
              id: createSafeId<"entityDeletionEffectChunk">(),
              payloadHash: chunk.payloadHash,
              requestId,
              s3Keys: chunk.s3Keys,
            })),
          );
        },
        items: chunks,
      });
    }
    if (chunks.length === 0) {
      await synchronizeParentProjection(tx, requestId);
    }
    return chunks.length;
  });

export const claimNextEntityDeletionEffectChunk = async (
  requestId: SafeId<"entityDeletionCleanupRequest">,
  db: EntityDeletionEffectDb = rootDb,
): Promise<EntityDeletionEffectClaim | null> =>
  await db.transaction(async (tx) => {
    const now = new Date();
    const candidate = (
      await tx
        .select({ id: entityDeletionEffectChunks.id })
        .from(entityDeletionEffectChunks)
        .where(
          and(
            eq(entityDeletionEffectChunks.requestId, requestId),
            eligibleChunkPredicate(),
          ),
        )
        .orderBy(asc(entityDeletionEffectChunks.chunkIndex))
        .limit(1)
        .for("update", { skipLocked: true })
    ).at(0);
    if (!candidate) {
      return null;
    }
    const lease = createEffectLease(ENTITY_DELETION_EFFECT_KIND);
    const claimed = (
      await tx
        .update(entityDeletionEffectChunks)
        .set({
          attemptCount: sql`${entityDeletionEffectChunks.attemptCount} + 1`,
          errorMessage: null,
          leaseExpiresAt: new Date(
            now.getTime() + ENTITY_DELETION_EFFECT_LEASE_MS,
          ),
          leaseToken: lease.token,
          nextAttemptAt: null,
          status: "processing",
          updatedAt: now,
        })
        .where(
          and(
            eq(entityDeletionEffectChunks.id, candidate.id),
            eligibleChunkPredicate(),
          ),
        )
        .returning({
          attemptCount: entityDeletionEffectChunks.attemptCount,
          chunkIndex: entityDeletionEffectChunks.chunkIndex,
          chunkId: entityDeletionEffectChunks.id,
          payloadHash: entityDeletionEffectChunks.payloadHash,
          requestId: entityDeletionEffectChunks.requestId,
          s3Keys: entityDeletionEffectChunks.s3Keys,
        })
    ).at(0);
    if (!claimed) {
      return null;
    }
    assertValidS3DeletionEffectChunk(claimed);
    await tx
      .update(entityDeletionCleanupRequests)
      .set({
        completedAt: null,
        errorMessage: null,
        nextAttemptAt: null,
        status: "processing",
        updatedAt: now,
      })
      .where(eq(entityDeletionCleanupRequests.id, requestId));
    return {
      attemptCount: claimed.attemptCount,
      chunkId: claimed.chunkId,
      lease,
      requestId: claimed.requestId,
      s3Keys: claimed.s3Keys,
    };
  });

export const completeEntityDeletionEffectChunk = async (
  claim: EntityDeletionEffectClaim,
  db: EntityDeletionEffectDb = rootDb,
): Promise<boolean> =>
  await db.transaction(async (tx) => {
    const settled = (
      await tx
        .update(entityDeletionEffectChunks)
        .set({
          completedAt: new Date(),
          errorMessage: null,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: null,
          s3Keys: [],
          status: "completed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(entityDeletionEffectChunks.id, claim.chunkId),
            eq(entityDeletionEffectChunks.requestId, claim.requestId),
            eq(entityDeletionEffectChunks.status, "processing"),
            eq(entityDeletionEffectChunks.leaseToken, claim.lease.token),
          ),
        )
        .returning({ id: entityDeletionEffectChunks.id })
    ).at(0);
    if (!settled) {
      return false;
    }
    await synchronizeParentProjection(tx, claim.requestId);
    return true;
  });

export const failEntityDeletionEffectChunk = async (
  claim: EntityDeletionEffectClaim,
  error: Error,
  db: EntityDeletionEffectDb = rootDb,
): Promise<boolean> =>
  await db.transaction(async (tx) => {
    const failedAt = new Date();
    const settled = (
      await tx
        .update(entityDeletionEffectChunks)
        .set({
          errorMessage: error.message,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: getDestructiveEffectRetryAt({
            attemptCount: claim.attemptCount,
            now: failedAt,
          }),
          status: "failed",
          updatedAt: failedAt,
        })
        .where(
          and(
            eq(entityDeletionEffectChunks.id, claim.chunkId),
            eq(entityDeletionEffectChunks.requestId, claim.requestId),
            eq(entityDeletionEffectChunks.status, "processing"),
            eq(entityDeletionEffectChunks.leaseToken, claim.lease.token),
          ),
        )
        .returning({ id: entityDeletionEffectChunks.id })
    ).at(0);
    if (!settled) {
      return false;
    }
    await synchronizeParentProjection(tx, claim.requestId);
    return true;
  });

export const listRecoverableEntityDeletionEffectRequestIds = async (
  db: EntityDeletionEffectDb = rootDb,
): Promise<SafeId<"entityDeletionCleanupRequest">[]> => {
  const legacyNow = new Date();
  const legacyStaleBefore = new Date(
    legacyNow.getTime() - DESTRUCTIVE_EFFECT_LEGACY_STALE_PROCESSING_MS,
  );
  const legacyRows = await db
    .select({ id: entityDeletionCleanupRequests.id })
    .from(entityDeletionCleanupRequests)
    .where(
      and(
        or(
          eq(entityDeletionCleanupRequests.status, "pending"),
          and(
            eq(entityDeletionCleanupRequests.status, "failed"),
            lte(entityDeletionCleanupRequests.nextAttemptAt, legacyNow),
          ),
          and(
            eq(entityDeletionCleanupRequests.status, "processing"),
            lt(entityDeletionCleanupRequests.updatedAt, legacyStaleBefore),
          ),
        ),
        notExists(
          db
            .select({ id: entityDeletionEffectChunks.id })
            .from(entityDeletionEffectChunks)
            .where(
              eq(
                entityDeletionEffectChunks.requestId,
                entityDeletionCleanupRequests.id,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(entityDeletionCleanupRequests.createdAt))
    .limit(RECOVERY_STATE_LIMIT);
  const chunkRows = await db
    .selectDistinct({
      recoveryUpdatedAt: entityDeletionCleanupRequests.updatedAt,
      requestId: entityDeletionEffectChunks.requestId,
    })
    .from(entityDeletionEffectChunks)
    .innerJoin(
      entityDeletionCleanupRequests,
      eq(
        entityDeletionCleanupRequests.id,
        entityDeletionEffectChunks.requestId,
      ),
    )
    .where(eligibleChunkPredicate())
    .orderBy(
      asc(entityDeletionCleanupRequests.updatedAt),
      asc(entityDeletionEffectChunks.requestId),
    )
    .limit(RECOVERY_STATE_LIMIT);
  return [
    ...new Set([
      ...legacyRows.map(({ id }) => id),
      ...chunkRows.map(({ requestId }) => requestId),
    ]),
  ];
};
