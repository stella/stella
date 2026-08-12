import { and, asc, eq, lt, ne, notExists, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  accountDeletionEffectChunks,
  accountDeletionRequests,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  DESTRUCTIVE_EFFECT_CHUNK_INSERT_BATCH_SIZE,
  assertValidS3DeletionEffectChunk,
  consumeInBatches,
  createS3DeletionEffectChunks,
  getDestructiveEffectRetryAt,
} from "@/api/lib/destructive-effect-chunks";
import { createEffectLease } from "@/api/lib/effect-lease";
import type { EffectLease } from "@/api/lib/effect-lease";

export const ACCOUNT_DELETION_EFFECT_KIND = "account-deletion-s3" as const;
export const ACCOUNT_DELETION_EFFECT_LEASE_MS = 15 * 60_000;
export const ACCOUNT_DELETION_EFFECT_MAX_ATTEMPTS = 20;
const RECOVERY_STATE_LIMIT = 50;

export type AccountDeletionEffectClaim = {
  attemptCount: number;
  chunkId: SafeId<"accountDeletionEffectChunk">;
  lease: EffectLease<typeof ACCOUNT_DELETION_EFFECT_KIND>;
  requestId: SafeId<"accountDeletionRequest">;
  s3Keys: string[];
};

type AccountDeletionEffectDb = Pick<
  typeof rootDb,
  "select" | "selectDistinct" | "transaction"
>;

const eligibleChunkPredicate = () =>
  and(
    lt(
      accountDeletionEffectChunks.attemptCount,
      ACCOUNT_DELETION_EFFECT_MAX_ATTEMPTS,
    ),
    or(
      eq(accountDeletionEffectChunks.status, "pending"),
      and(
        eq(accountDeletionEffectChunks.status, "failed"),
        sql`${accountDeletionEffectChunks.nextAttemptAt} <= CURRENT_TIMESTAMP`,
      ),
      and(
        eq(accountDeletionEffectChunks.status, "processing"),
        sql`${accountDeletionEffectChunks.leaseExpiresAt} <= CURRENT_TIMESTAMP`,
      ),
    ),
  );

const deriveParentStatus = (
  states: ReadonlySet<
    (typeof accountDeletionEffectChunks.$inferSelect)["status"]
  >,
): (typeof accountDeletionRequests.$inferSelect)["status"] => {
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
  requestId: SafeId<"accountDeletionRequest">,
): Promise<void> => {
  const parent = (
    await tx
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, requestId))
      .limit(1)
      .for("update")
  ).at(0);
  if (!parent) {
    return;
  }
  const states = await tx
    .selectDistinct({ status: accountDeletionEffectChunks.status })
    .from(accountDeletionEffectChunks)
    .where(eq(accountDeletionEffectChunks.requestId, requestId))
    .limit(4);
  const status = deriveParentStatus(
    new Set(states.map(({ status: chunkStatus }) => chunkStatus)),
  );
  const failed =
    status === "failed"
      ? (
          await tx
            .select({ errorMessage: accountDeletionEffectChunks.errorMessage })
            .from(accountDeletionEffectChunks)
            .where(
              and(
                eq(accountDeletionEffectChunks.requestId, requestId),
                eq(accountDeletionEffectChunks.status, "failed"),
              ),
            )
            .orderBy(asc(accountDeletionEffectChunks.chunkIndex))
            .limit(1)
        ).at(0)
      : undefined;
  await tx
    .update(accountDeletionRequests)
    .set({
      completedAt: status === "completed" ? new Date() : null,
      errorMessage: failed?.errorMessage ?? null,
      status,
      storageCleanup:
        status === "completed"
          ? { s3Keys: [] }
          : sql`${accountDeletionRequests.storageCleanup}`,
      updatedAt: new Date(),
    })
    .where(eq(accountDeletionRequests.id, requestId));
};

export const ensureAccountDeletionEffectChunks = async (
  requestId: SafeId<"accountDeletionRequest">,
  db: AccountDeletionEffectDb = rootDb,
): Promise<number> =>
  await db.transaction(async (tx) => {
    const request = (
      await tx
        .select({ storageCleanup: accountDeletionRequests.storageCleanup })
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, requestId))
        .limit(1)
        .for("update")
    ).at(0);
    if (!request) {
      return 0;
    }
    const existing = (
      await tx
        .select({ id: accountDeletionEffectChunks.id })
        .from(accountDeletionEffectChunks)
        .where(eq(accountDeletionEffectChunks.requestId, requestId))
        .limit(1)
    ).at(0);
    if (existing) {
      return 0;
    }
    const chunks = createS3DeletionEffectChunks(request.storageCleanup.s3Keys);
    if (chunks.length > 0) {
      await consumeInBatches({
        batchSize: DESTRUCTIVE_EFFECT_CHUNK_INSERT_BATCH_SIZE,
        consume: async (batch) => {
          // audit: skip — rolling-deploy materialization of the parent
          // deletion intent; the parent row remains the audit record.
          await tx.insert(accountDeletionEffectChunks).values(
            batch.map((chunk) => ({
              chunkIndex: chunk.chunkIndex,
              effectType: chunk.effectType,
              id: createSafeId<"accountDeletionEffectChunk">(),
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

export const claimNextAccountDeletionEffectChunk = async (
  requestId: SafeId<"accountDeletionRequest">,
  db: AccountDeletionEffectDb = rootDb,
): Promise<AccountDeletionEffectClaim | null> =>
  await db.transaction(async (tx) => {
    const now = new Date();
    const candidate = (
      await tx
        .select({ id: accountDeletionEffectChunks.id })
        .from(accountDeletionEffectChunks)
        .where(
          and(
            eq(accountDeletionEffectChunks.requestId, requestId),
            eligibleChunkPredicate(),
          ),
        )
        .orderBy(asc(accountDeletionEffectChunks.chunkIndex))
        .limit(1)
        .for("update", { skipLocked: true })
    ).at(0);
    if (!candidate) {
      return null;
    }
    const lease = createEffectLease(ACCOUNT_DELETION_EFFECT_KIND);
    const claimed = (
      await tx
        .update(accountDeletionEffectChunks)
        .set({
          attemptCount: sql`${accountDeletionEffectChunks.attemptCount} + 1`,
          errorMessage: null,
          leaseExpiresAt: new Date(
            now.getTime() + ACCOUNT_DELETION_EFFECT_LEASE_MS,
          ),
          leaseToken: lease.token,
          nextAttemptAt: null,
          status: "processing",
          updatedAt: now,
        })
        .where(
          and(
            eq(accountDeletionEffectChunks.id, candidate.id),
            eligibleChunkPredicate(),
          ),
        )
        .returning({
          attemptCount: accountDeletionEffectChunks.attemptCount,
          chunkIndex: accountDeletionEffectChunks.chunkIndex,
          chunkId: accountDeletionEffectChunks.id,
          payloadHash: accountDeletionEffectChunks.payloadHash,
          requestId: accountDeletionEffectChunks.requestId,
          s3Keys: accountDeletionEffectChunks.s3Keys,
        })
    ).at(0);
    if (!claimed) {
      return null;
    }
    assertValidS3DeletionEffectChunk(claimed);
    await tx
      .update(accountDeletionRequests)
      .set({
        completedAt: null,
        errorMessage: null,
        status: "processing",
        updatedAt: now,
      })
      .where(eq(accountDeletionRequests.id, requestId));
    return {
      attemptCount: claimed.attemptCount,
      chunkId: claimed.chunkId,
      lease,
      requestId: claimed.requestId,
      s3Keys: claimed.s3Keys,
    };
  });

export const completeAccountDeletionEffectChunk = async (
  claim: AccountDeletionEffectClaim,
  db: AccountDeletionEffectDb = rootDb,
): Promise<boolean> =>
  await db.transaction(async (tx) => {
    const settled = (
      await tx
        .update(accountDeletionEffectChunks)
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
            eq(accountDeletionEffectChunks.id, claim.chunkId),
            eq(accountDeletionEffectChunks.requestId, claim.requestId),
            eq(accountDeletionEffectChunks.status, "processing"),
            eq(accountDeletionEffectChunks.leaseToken, claim.lease.token),
          ),
        )
        .returning({ id: accountDeletionEffectChunks.id })
    ).at(0);
    if (!settled) {
      return false;
    }
    await synchronizeParentProjection(tx, claim.requestId);
    return true;
  });

export const failAccountDeletionEffectChunk = async (
  claim: AccountDeletionEffectClaim,
  error: Error,
  db: AccountDeletionEffectDb = rootDb,
): Promise<boolean> =>
  await db.transaction(async (tx) => {
    const failedAt = new Date();
    const settled = (
      await tx
        .update(accountDeletionEffectChunks)
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
            eq(accountDeletionEffectChunks.id, claim.chunkId),
            eq(accountDeletionEffectChunks.requestId, claim.requestId),
            eq(accountDeletionEffectChunks.status, "processing"),
            eq(accountDeletionEffectChunks.leaseToken, claim.lease.token),
          ),
        )
        .returning({ id: accountDeletionEffectChunks.id })
    ).at(0);
    if (!settled) {
      return false;
    }
    await synchronizeParentProjection(tx, claim.requestId);
    return true;
  });

export const listRecoverableAccountDeletionEffectRequestIds = async (
  db: AccountDeletionEffectDb = rootDb,
): Promise<SafeId<"accountDeletionRequest">[]> => {
  const legacyRows = await db
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        ne(accountDeletionRequests.status, "completed"),
        notExists(
          db
            .select({ id: accountDeletionEffectChunks.id })
            .from(accountDeletionEffectChunks)
            .where(
              eq(
                accountDeletionEffectChunks.requestId,
                accountDeletionRequests.id,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(accountDeletionRequests.createdAt))
    .limit(RECOVERY_STATE_LIMIT);
  const chunkRows = await db
    .selectDistinct({
      recoveryUpdatedAt: accountDeletionRequests.updatedAt,
      requestId: accountDeletionEffectChunks.requestId,
    })
    .from(accountDeletionEffectChunks)
    .innerJoin(
      accountDeletionRequests,
      eq(accountDeletionRequests.id, accountDeletionEffectChunks.requestId),
    )
    .where(eligibleChunkPredicate())
    .orderBy(
      asc(accountDeletionRequests.updatedAt),
      asc(accountDeletionEffectChunks.requestId),
    )
    .limit(RECOVERY_STATE_LIMIT);
  return [
    ...new Set([
      ...legacyRows.map(({ id }) => id),
      ...chunkRows.map(({ requestId }) => requestId),
    ]),
  ];
};
