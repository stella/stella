import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { corpusIndexProjectionIntents } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexDeleteSettlement,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexIntentStatus } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { readRegisteredCorpusProjectionManifestForCleanup } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  corpusIndexUnknownAppendBarrierAt,
  countCorpusProjectionRevisions,
  readCorpusProjectionDeleteSettlement,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  CORPUS_PROJECTION_LEASE_MAX_MS,
  CORPUS_PROJECTION_LEASE_MIN_MS,
} from "@/api/lib/legal-search/corpus-index-projection-store";

type ProjectionIntentId = SafeId<"corpusIndexProjectionIntent">;

const validateCleanupBatchSize = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic(
      `Corpus projection cleanup batch size must be an integer from 1 to ${CORPUS_PROJECTION_DELETE_MAX_REVISIONS}`,
    );
  }
  return limit;
};

const validateLeaseMs = (leaseMs: number): number => {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < CORPUS_PROJECTION_LEASE_MIN_MS ||
    leaseMs > CORPUS_PROJECTION_LEASE_MAX_MS
  ) {
    return panic(
      `Corpus projection lease must be an integer from ${CORPUS_PROJECTION_LEASE_MIN_MS} to ${CORPUS_PROJECTION_LEASE_MAX_MS} milliseconds`,
    );
  }
  return leaseMs;
};

export type CorpusProjectionCleanupLease = {
  intentId: ProjectionIntentId;
  family: CorpusFamily;
  generation: string;
  entityId: string;
  indexId: string;
  leaseToken: string;
};

type ClaimCorpusProjectionCleanupOptions = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  limit: number;
  leaseMs: number;
  now?: Date;
  newLeaseToken?: () => string;
};

export const claimCorpusProjectionCleanupTx = async (
  tx: Transaction,
  {
    family,
    generation,
    indexId,
    limit: requestedLimit,
    leaseMs: requestedLeaseMs,
    now,
    newLeaseToken = () => Bun.randomUUIDv7(),
  }: ClaimCorpusProjectionCleanupOptions,
): Promise<CorpusProjectionCleanupLease[]> => {
  const limit = validateCleanupBatchSize(requestedLimit);
  const leaseMs = validateLeaseMs(requestedLeaseMs);
  await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    family,
    generation,
  );
  const candidates = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_pending"),
        sql`${corpusIndexProjectionIntents.cleanupNotBefore} <= clock_timestamp()`,
        or(
          isNull(corpusIndexProjectionIntents.leaseExpiresAt),
          sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
        ),
      ),
    )
    .orderBy(
      asc(corpusIndexProjectionIntents.cleanupNotBefore),
      asc(corpusIndexProjectionIntents.createdAt),
    )
    .limit(limit)
    .for("update", { skipLocked: true });
  if (candidates.length === 0) {
    return [];
  }
  const claimAt = now ?? sql<Date>`clock_timestamp()`;
  const leaseToken = newLeaseToken();
  const leaseExpiresAt =
    now === undefined
      ? sql<Date>`clock_timestamp() + ${leaseMs} * INTERVAL '1 millisecond'`
      : new Date(now.getTime() + leaseMs);
  const ids = candidates.map(({ id }) => id);
  const updated = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_started",
      leaseToken,
      leaseExpiresAt,
      cleanupStartedAt: claimAt,
      cleanupAttempts: sql`${corpusIndexProjectionIntents.cleanupAttempts} + 1`,
      updatedAt: claimAt,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, ids),
        eq(corpusIndexProjectionIntents.status, "cleanup_pending"),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (updated.length !== candidates.length) {
    return panic(
      `Corpus projection cleanup claimed ${updated.length} of ${candidates.length} revisions`,
    );
  }
  return candidates.map((candidate) => ({
    intentId: candidate.id,
    family,
    generation,
    entityId: candidate.entityId,
    indexId,
    leaseToken,
  }));
};

type RecordCorpusProjectionDeleteOptions = {
  intentIds: readonly ProjectionIntentId[];
  indexId: string;
  leaseToken: string;
  deleteOpstamp: number;
  now?: Date;
};

export const recordCorpusProjectionDeleteTx = async (
  tx: Transaction,
  {
    intentIds,
    indexId,
    leaseToken,
    deleteOpstamp,
    now = new Date(),
  }: RecordCorpusProjectionDeleteOptions,
): Promise<number> => {
  if (
    intentIds.length === 0 ||
    intentIds.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS ||
    !Number.isSafeInteger(deleteOpstamp) ||
    deleteOpstamp < 0
  ) {
    return panic("Corpus projection delete receipt is invalid");
  }
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_committed",
      leaseToken: null,
      leaseExpiresAt: null,
      deleteOpstamp: BigInt(deleteOpstamp),
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_started"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length !== intentIds.length) {
    return panic(
      `Corpus projection delete receipt matched ${rows.length} of ${intentIds.length} leased revisions`,
    );
  }
  return rows.length;
};

type RetryCorpusProjectionCleanupOptions = {
  intentIds: readonly ProjectionIntentId[];
  leaseToken: string;
  errorMessage: string;
  now?: Date;
};

export const retryCorpusProjectionCleanupTx = async (
  tx: Transaction,
  {
    intentIds,
    leaseToken,
    errorMessage,
    now = new Date(),
  }: RetryCorpusProjectionCleanupOptions,
): Promise<number> => {
  if (intentIds.length === 0) {
    return 0;
  }
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      cleanupStartedAt: null,
      lastError: errorMessage.slice(0, 2048),
      updatedAt: now,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.status, "cleanup_started"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  return rows.length;
};

type VerifyCorpusProjectionCleanupSettlementOptions = {
  client: Pick<CorpusIndexClient, "readDeleteSettlement" | "search">;
  lease: CorpusProjectionCleanupSettlementLease;
};

export type CorpusProjectionCleanupSettlementLease = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  intentIds: readonly ProjectionIntentId[];
  deleteOpstamp: number;
  leaseToken: string;
};

type ClaimCorpusProjectionCleanupSettlementOptions = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  limit: number;
  leaseMs: number;
  now?: Date;
  newLeaseToken?: () => string;
};

export const claimCorpusProjectionCleanupSettlementTx = async (
  tx: Transaction,
  {
    family,
    generation,
    indexId,
    limit: requestedLimit,
    leaseMs: requestedLeaseMs,
    now = new Date(),
    newLeaseToken = () => Bun.randomUUIDv7(),
  }: ClaimCorpusProjectionCleanupSettlementOptions,
): Promise<CorpusProjectionCleanupSettlementLease | null> => {
  const limit = validateCleanupBatchSize(requestedLimit);
  const leaseMs = validateLeaseMs(requestedLeaseMs);
  await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    family,
    generation,
  );
  const first = await tx
    .select({ deleteOpstamp: corpusIndexProjectionIntents.deleteOpstamp })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        or(
          isNull(corpusIndexProjectionIntents.leaseExpiresAt),
          sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
        ),
      ),
    )
    .orderBy(
      asc(corpusIndexProjectionIntents.cleanupStartedAt),
      asc(corpusIndexProjectionIntents.createdAt),
    )
    .limit(1)
    .for("update", { skipLocked: true });
  const deleteOpstamp = first.at(0)?.deleteOpstamp;
  if (deleteOpstamp === undefined) {
    return null;
  }
  if (deleteOpstamp === null) {
    return panic("Committed corpus projection cleanup has no delete opstamp");
  }
  const candidates = await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        eq(corpusIndexProjectionIntents.deleteOpstamp, deleteOpstamp),
        or(
          isNull(corpusIndexProjectionIntents.leaseExpiresAt),
          sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
        ),
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  if (candidates.length === 0) {
    return null;
  }
  const leaseToken = newLeaseToken();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const intentIds = candidates.map(({ id }) => id);
  const claimed = await tx
    .update(corpusIndexProjectionIntents)
    .set({ leaseToken, leaseExpiresAt, updatedAt: now })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        eq(corpusIndexProjectionIntents.deleteOpstamp, deleteOpstamp),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (claimed.length !== candidates.length) {
    return panic(
      `Corpus projection settlement claimed ${claimed.length} of ${candidates.length} revisions`,
    );
  }
  const numericOpstamp = Number(deleteOpstamp);
  if (!Number.isSafeInteger(numericOpstamp) || numericOpstamp < 0) {
    return panic("Corpus projection delete opstamp exceeds safe integer range");
  }
  return {
    family,
    generation,
    indexId,
    intentIds,
    deleteOpstamp: numericOpstamp,
    leaseToken,
  };
};

export type CorpusProjectionCleanupSettlementResult =
  | {
      status: "pending";
      settlement: CorpusIndexDeleteSettlement;
      remainingRevisionCount: number | null;
    }
  | {
      status: "verified";
      proof: CorpusProjectionCleanupSettlementProof;
    };

/**
 * Opaque evidence that Quickwit's published splits crossed the delete opstamp
 * and an exact revision query observed zero remaining documents.
 */
export class CorpusProjectionCleanupSettlementProof {
  private constructor(
    readonly indexId: string,
    readonly intentIds: readonly ProjectionIntentId[],
    readonly deleteOpstamp: number,
    readonly leaseToken: string,
  ) {}

  static async verify({
    client,
    lease,
  }: VerifyCorpusProjectionCleanupSettlementOptions): Promise<
    Result<CorpusProjectionCleanupSettlementResult, CorpusIndexError>
  > {
    const { indexId, intentIds, deleteOpstamp, leaseToken } = lease;
    if (
      intentIds.length === 0 ||
      intentIds.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS ||
      !Number.isSafeInteger(deleteOpstamp) ||
      deleteOpstamp < 0
    ) {
      return panic("Corpus projection settlement request is invalid");
    }
    const settlement = await readCorpusProjectionDeleteSettlement({
      client,
      indexId,
      requiredOpstamp: deleteOpstamp,
    });
    if (settlement.isErr()) {
      return Result.err(settlement.error);
    }
    if (!settlement.value.settled) {
      return Result.ok({
        status: "pending",
        settlement: settlement.value,
        remainingRevisionCount: null,
      });
    }
    const remaining = await countCorpusProjectionRevisions({
      client,
      indexId,
      revisions: intentIds,
    });
    if (remaining.isErr()) {
      return Result.err(remaining.error);
    }
    if (remaining.value !== 0) {
      return Result.ok({
        status: "pending",
        settlement: settlement.value,
        remainingRevisionCount: remaining.value,
      });
    }
    return Result.ok({
      status: "verified",
      proof: new CorpusProjectionCleanupSettlementProof(
        indexId,
        [...intentIds],
        deleteOpstamp,
        leaseToken,
      ),
    });
  }
}

type ReleaseCorpusProjectionCleanupSettlementOptions = {
  lease: CorpusProjectionCleanupSettlementLease;
  now?: Date;
};

export const releaseCorpusProjectionCleanupSettlementTx = async (
  tx: Transaction,
  { lease, now = new Date() }: ReleaseCorpusProjectionCleanupSettlementOptions,
): Promise<number> => {
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({ leaseToken: null, leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, lease.intentIds),
        eq(corpusIndexProjectionIntents.indexId, lease.indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        eq(
          corpusIndexProjectionIntents.deleteOpstamp,
          BigInt(lease.deleteOpstamp),
        ),
        eq(corpusIndexProjectionIntents.leaseToken, lease.leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length !== lease.intentIds.length) {
    return panic(
      `Corpus projection settlement release matched ${rows.length} of ${lease.intentIds.length} leased revisions`,
    );
  }
  return rows.length;
};

type SettleCorpusProjectionCleanupOptions = {
  proof: CorpusProjectionCleanupSettlementProof;
  now?: Date;
};

export const settleCorpusProjectionCleanupTx = async (
  tx: Transaction,
  { proof, now = new Date() }: SettleCorpusProjectionCleanupOptions,
): Promise<number> => {
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "settled",
      leaseToken: null,
      leaseExpiresAt: null,
      settledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, proof.intentIds),
        eq(corpusIndexProjectionIntents.indexId, proof.indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        eq(
          corpusIndexProjectionIntents.deleteOpstamp,
          BigInt(proof.deleteOpstamp),
        ),
        eq(corpusIndexProjectionIntents.leaseToken, proof.leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length !== proof.intentIds.length) {
    return panic(
      `Corpus projection settlement matched ${rows.length} of ${proof.intentIds.length} verified revisions`,
    );
  }
  return rows.length;
};

type ReopenCorpusProjectionCleanupOptions = {
  intentIds: readonly ProjectionIntentId[];
  indexId: string;
  errorMessage: string;
  now?: Date;
};

/** Reopen exact settled revisions when a later census observes them again. */
export const reopenCorpusProjectionCleanupTx = async (
  tx: Transaction,
  {
    intentIds,
    indexId,
    errorMessage,
    now = new Date(),
  }: ReopenCorpusProjectionCleanupOptions,
): Promise<number> => {
  if (
    intentIds.length === 0 ||
    intentIds.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic("Corpus projection cleanup reopen request is invalid");
  }
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      cleanupNotBefore: now,
      cleanupStartedAt: null,
      deleteOpstamp: null,
      settledAt: null,
      lastError: errorMessage.slice(0, 2048),
      updatedAt: now,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        eq(corpusIndexProjectionIntents.status, "settled"),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length !== intentIds.length) {
    return panic(
      `Corpus projection cleanup reopen matched ${rows.length} of ${intentIds.length} settled revisions`,
    );
  }
  return rows.length;
};

export type CorpusProjectionExpiredIntent = {
  intentId: ProjectionIntentId;
  status: Extract<
    CorpusIndexIntentStatus,
    "reserved" | "append_started" | "cleanup_started"
  >;
};

type RecoverExpiredCorpusProjectionIntentsOptions = {
  family: CorpusFamily;
  generation: string;
  limit: number;
  now?: Date;
};

/**
 * Recover only states whose external outcome is known from the recorded phase:
 * an expired reservation is cancelled, an expired append is assumed written,
 * and an expired delete is retried exactly.
 */
export const recoverExpiredCorpusProjectionIntentsTx = async (
  tx: Transaction,
  {
    family,
    generation,
    limit: requestedLimit,
    now = new Date(),
  }: RecoverExpiredCorpusProjectionIntentsOptions,
): Promise<CorpusProjectionExpiredIntent[]> => {
  const limit = validateCleanupBatchSize(requestedLimit);
  const manifest = await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    family,
    generation,
  );
  const rows = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      status: corpusIndexProjectionIntents.status,
      appendStartedAt: corpusIndexProjectionIntents.appendStartedAt,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        inArray(corpusIndexProjectionIntents.status, [
          "reserved",
          "append_started",
          "cleanup_started",
        ]),
        sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.leaseExpiresAt))
    .limit(limit)
    .for("update", { skipLocked: true });

  const reserved = rows.filter(({ status }) => status === "reserved");
  if (reserved.length > 0) {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cancelled",
        leaseToken: null,
        leaseExpiresAt: null,
        cancelledAt: now,
        lastError: "projection reservation lease expired before append",
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            reserved.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "reserved"),
        ),
      );
  }

  const cleanupStarted = rows.filter(
    ({ status }) => status === "cleanup_started",
  );
  if (cleanupStarted.length > 0) {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cleanup_pending",
        leaseToken: null,
        leaseExpiresAt: null,
        cleanupStartedAt: null,
        lastError: "projection cleanup lease expired with unknown outcome",
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            cleanupStarted.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "cleanup_started"),
        ),
      );
  }

  const appendStarted = rows.filter(
    ({ status }) => status === "append_started",
  );
  if (appendStarted.length > 0) {
    const barriers = appendStarted.map((row) => {
      if (row.appendStartedAt === null) {
        return panic(
          `Append-started projection intent has no start: ${row.id}`,
        );
      }
      return {
        id: row.id,
        barrier: corpusIndexUnknownAppendBarrierAt(
          row.appendStartedAt,
          manifest,
        ),
      };
    });
    const barrierSql = sql`CASE ${corpusIndexProjectionIntents.id} ${sql.join(
      barriers.map(
        ({ id, barrier }) => sql`WHEN ${id} THEN ${barrier}::timestamptz`,
      ),
      sql.raw(" "),
    )} ELSE ${corpusIndexProjectionIntents.appendPublishBarrierAt} END`;
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cleanup_pending",
        leaseToken: null,
        leaseExpiresAt: null,
        appendPublishBarrierAt: barrierSql,
        cleanupNotBefore: barrierSql,
        lastError: "projection append lease expired with unknown outcome",
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            appendStarted.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "append_started"),
        ),
      );
  }
  return rows.map(({ id, status }) => {
    if (
      status !== "reserved" &&
      status !== "append_started" &&
      status !== "cleanup_started"
    ) {
      return panic(`Unexpected expired projection intent status: ${status}`);
    }
    return { intentId: id, status };
  });
};
