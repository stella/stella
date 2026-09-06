import { Result, TaggedError, panic } from "better-result";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS,
  caseLawCorpusUploadIntents,
  caseLawDecisions,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  type ActiveCorpusProjectionSourceLock,
  CorpusIndexProjectionSubjectMissingError,
  lockActiveCorpusProjectionSourceTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  corpusKeys,
  deleteCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusDeleteOutcome,
  CorpusWriteOutcome,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";

const CLEANUP_RETRY_MAX_DELAY_MS = DAY_IN_MS;
const CLEANUP_RETRY_UNIT_MS = 60 * 1000;
const CORPUS_UPLOAD_INTENT_LEASE_MS = 5 * 60 * 1000;

type CorpusUploadKeys = Pick<
  WriteCorpusResult,
  "astKey" | "sectionsKey" | "textKey"
>;

type CorpusUploadIntentCleanupPlan =
  | { type: "defer" }
  | {
      type: "delete";
      keys: {
        astKey: string | null;
        sectionsKey: string | null;
        textKey: string | null;
      };
    };

/** A cleanup may delete only keys owned by neither a live row nor an upload. */
export const planCorpusUploadIntentCleanup = (
  keys: CorpusUploadKeys,
  currentKeys: ReadonlySet<string>,
  activeKeys: ReadonlySet<string>,
): CorpusUploadIntentCleanupPlan => {
  const rowKeys = [keys.astKey, keys.sectionsKey, keys.textKey];
  if (rowKeys.some((key) => activeKeys.has(key))) {
    return { type: "defer" };
  }
  return {
    type: "delete",
    keys: {
      astKey: currentKeys.has(keys.astKey) ? null : keys.astKey,
      sectionsKey: currentKeys.has(keys.sectionsKey) ? null : keys.sectionsKey,
      textKey: currentKeys.has(keys.textKey) ? null : keys.textKey,
    },
  };
};

type ReserveCaseLawCorpusUploadIntentOptions = {
  contentHash: string;
  decisionId: SafeId<"caseLawDecision">;
  jurisdiction: string;
  scopedDb: ScopedDb;
};

export type ReserveCaseLawCorpusUploadIntentResult =
  | {
      intentId: SafeId<"caseLawCorpusUploadIntent">;
      type: "reserved";
      written: WriteCorpusResult;
    }
  | { type: "busy" }
  | { type: "redacted" };

/**
 * Reserve exact object keys before any external PUT. `FOR SHARE` serializes
 * this short reservation with redaction's `FOR UPDATE` fence: either the
 * upload is durable for cancellation, or a tombstone prevents it starting.
 */
export const reserveCaseLawCorpusUploadIntent = async ({
  contentHash,
  decisionId,
  jurisdiction,
  scopedDb,
}: ReserveCaseLawCorpusUploadIntentOptions): Promise<ReserveCaseLawCorpusUploadIntentResult> => {
  const keys = corpusKeys({
    contentHash,
    documentId: decisionId,
    jurisdiction,
  });
  return await scopedDb(async (tx) => {
    const decision = (
      await tx
        .select({ redactedAt: caseLawDecisions.redactedAt })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .for("share")
        .limit(1)
    ).at(0);
    if (!decision || decision.redactedAt !== null) {
      return { type: "redacted" };
    }

    const intentId = createSafeId<"caseLawCorpusUploadIntent">();
    const leaseExpiresAt = new Date(Date.now() + CORPUS_UPLOAD_INTENT_LEASE_MS);
    const reserved = (
      await tx
        .insert(caseLawCorpusUploadIntents)
        .values({
          id: intentId,
          decisionId,
          textS3Key: keys.textKey,
          normalizedS3Key: keys.sectionsKey,
          astS3Key: keys.astKey,
          leaseExpiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: caseLawCorpusUploadIntents.id })
    ).at(0);
    if (reserved) {
      return {
        intentId,
        type: "reserved",
        written: { ...keys, contentHash },
      };
    }

    const active = (
      await tx
        .select({
          id: caseLawCorpusUploadIntents.id,
          textKey: caseLawCorpusUploadIntents.textS3Key,
          sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
          astKey: caseLawCorpusUploadIntents.astS3Key,
          leaseExpiresAt: caseLawCorpusUploadIntents.leaseExpiresAt,
        })
        .from(caseLawCorpusUploadIntents)
        .where(
          and(
            eq(caseLawCorpusUploadIntents.decisionId, decisionId),
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
            ),
          ),
        )
        .for("update")
        .limit(1)
    ).at(0);
    if (!active || active.leaseExpiresAt.getTime() > Date.now()) {
      return { type: "busy" };
    }

    const samePayload =
      active.textKey === keys.textKey &&
      active.sectionsKey === keys.sectionsKey &&
      active.astKey === keys.astKey;
    if (samePayload) {
      await tx
        .update(caseLawCorpusUploadIntents)
        .set({ leaseExpiresAt })
        .where(eq(caseLawCorpusUploadIntents.id, active.id));
      return {
        intentId: active.id,
        type: "reserved",
        written: { ...keys, contentHash },
      };
    }

    await tx
      .update(caseLawCorpusUploadIntents)
      .set({
        status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
        nextCleanupAt: new Date(),
      })
      .where(eq(caseLawCorpusUploadIntents.id, active.id));
    await tx.insert(caseLawCorpusUploadIntents).values({
      id: intentId,
      decisionId,
      textS3Key: keys.textKey,
      normalizedS3Key: keys.sectionsKey,
      astS3Key: keys.astKey,
      leaseExpiresAt,
    });
    return {
      intentId,
      type: "reserved",
      written: { ...keys, contentHash },
    };
  });
};

export type CaseLawCorpusUploadApplyResult =
  | { type: "applied" }
  | { type: "superseded" };

type WriteReservedCaseLawCorpusUploadOptions = {
  /**
   * Row CAS for the settled state. `written` is null when the write
   * concluded the payload carries no document, in which case the CAS
   * settles the mirror with null pointers instead of keys.
   */
  apply: (args: {
    projectionLock: ActiveCorpusProjectionSourceLock | null;
    tx: Transaction;
    written: WriteCorpusResult | null;
  }) => Promise<CaseLawCorpusUploadApplyResult>;
  decisionId: SafeId<"caseLawDecision">;
  intentId: SafeId<"caseLawCorpusUploadIntent">;
  preflight: (tx: Transaction) => Promise<boolean>;
  scopedDb: ScopedDb;
  signal?: AbortSignal;
  write: (args: { signal: AbortSignal }) => Promise<CorpusWriteOutcome>;
};

class CorpusUploadWriteError extends TaggedError("CorpusUploadWriteError")<{
  cause: unknown;
  message: string;
}> {}

export type WriteReservedCaseLawCorpusUploadResult =
  | CaseLawCorpusUploadApplyResult
  | { type: "redacted-or-missing" }
  | { type: "intent-reclaimed" };

/**
 * The exceptional transaction that holds a decision fence over its corpus
 * PUT. Redaction uses the same row lock, so it cannot win between the final
 * tombstone check and this upload. The callback applies its row CAS and the
 * active intent disappears in that same commit only after a successful write.
 */
export const writeReservedCaseLawCorpusUpload = async ({
  apply,
  decisionId,
  intentId,
  preflight,
  scopedDb,
  signal,
  write,
}: WriteReservedCaseLawCorpusUploadOptions): Promise<WriteReservedCaseLawCorpusUploadResult> => {
  try {
    return await scopedDb(async (tx) => {
      signal?.throwIfAborted();
      const sourceLock = await Result.tryPromise({
        try: async () =>
          await lockActiveCorpusProjectionSourceTx(tx, {
            family: "case_law",
            entityId: decisionId,
          }),
        catch: (cause) => cause,
      });
      if (Result.isError(sourceLock)) {
        if (
          sourceLock.error instanceof CorpusIndexProjectionSubjectMissingError
        ) {
          return { type: "redacted-or-missing" };
        }
        throw sourceLock.error;
      }
      const decision = (
        await tx
          .select({ redactedAt: caseLawDecisions.redactedAt })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, decisionId))
          .for("update")
          .limit(1)
      ).at(0);
      if (!decision || decision.redactedAt !== null) {
        await tx
          .update(caseLawCorpusUploadIntents)
          .set({
            status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
            nextCleanupAt: new Date(),
          })
          .where(
            and(
              eq(caseLawCorpusUploadIntents.id, intentId),
              eq(
                caseLawCorpusUploadIntents.status,
                CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
              ),
            ),
          );
        return { type: "redacted-or-missing" };
      }

      const intent = (
        await tx
          .select({ status: caseLawCorpusUploadIntents.status })
          .from(caseLawCorpusUploadIntents)
          .where(
            and(
              eq(caseLawCorpusUploadIntents.id, intentId),
              eq(caseLawCorpusUploadIntents.decisionId, decisionId),
            ),
          )
          .for("update")
          .limit(1)
      ).at(0);
      if (intent?.status !== CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE) {
        return { type: "intent-reclaimed" };
      }

      if (!(await preflight(tx))) {
        await tx
          .update(caseLawCorpusUploadIntents)
          .set({
            status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
            nextCleanupAt: new Date(),
          })
          .where(eq(caseLawCorpusUploadIntents.id, intentId));
        return { type: "superseded" };
      }

      let writeOutcome: CorpusWriteOutcome;
      try {
        writeOutcome = await write({
          signal: signal ?? new AbortController().signal,
        });
      } catch (error) {
        throw new CorpusUploadWriteError({
          cause: error,
          message: "Reserved corpus upload failed",
        });
      }
      const outcome = await apply({
        projectionLock: sourceLock.value,
        tx,
        written: writeOutcome.written,
      });
      if (outcome.type === "superseded") {
        await tx
          .update(caseLawCorpusUploadIntents)
          .set({
            status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
            nextCleanupAt: new Date(),
          })
          .where(eq(caseLawCorpusUploadIntents.id, intentId));
        return outcome;
      }

      const removed = (
        await tx
          .delete(caseLawCorpusUploadIntents)
          .where(
            and(
              eq(caseLawCorpusUploadIntents.id, intentId),
              eq(
                caseLawCorpusUploadIntents.status,
                CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
              ),
            ),
          )
          .returning({ id: caseLawCorpusUploadIntents.id })
      ).at(0);
      if (!removed) {
        return panic("Corpus upload intent disappeared before settlement");
      }
      return outcome;
    });
  } catch (error) {
    if (error instanceof CorpusUploadWriteError) {
      await enqueueCaseLawCorpusUploadIntentCleanup({ intentId, scopedDb });
      throw error.cause;
    }
    throw error;
  }
};

export type CancelledCaseLawCorpusUploadIntent = CorpusUploadKeys & {
  id: SafeId<"caseLawCorpusUploadIntent">;
};

/**
 * Must run in redaction's decision-row `FOR UPDATE` transaction. It retains
 * the exact keys until an immediate delete or the durable sweeper confirms
 * deletion, so a late or abandoned PUT remains owned by erasure.
 */
export const cancelCaseLawCorpusUploadIntents = async ({
  decisionId,
  tx,
}: {
  decisionId: SafeId<"caseLawDecision">;
  tx: Transaction;
}): Promise<CancelledCaseLawCorpusUploadIntent[]> =>
  await tx
    .update(caseLawCorpusUploadIntents)
    .set({
      status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
      nextCleanupAt: new Date(),
    })
    .where(
      and(
        eq(caseLawCorpusUploadIntents.decisionId, decisionId),
        eq(
          caseLawCorpusUploadIntents.status,
          CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
        ),
      ),
    )
    .returning({
      id: caseLawCorpusUploadIntents.id,
      textKey: caseLawCorpusUploadIntents.textS3Key,
      sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
      astKey: caseLawCorpusUploadIntents.astS3Key,
    });

/** Mark one failed, pre-reserved write for durable exact-key cleanup. */
export const enqueueCaseLawCorpusUploadIntentCleanup = async ({
  intentId,
  scopedDb,
}: {
  intentId: SafeId<"caseLawCorpusUploadIntent">;
  scopedDb: ScopedDb;
}): Promise<void> => {
  await scopedDb(async (tx) => {
    await tx
      .update(caseLawCorpusUploadIntents)
      .set({
        status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
        nextCleanupAt: new Date(),
      })
      .where(
        and(
          eq(caseLawCorpusUploadIntents.id, intentId),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
          ),
        ),
      );
  });
};

/**
 * Remove cancelled intents only after their exact-key deletes succeeded. The
 * caller passes the intents whose objects are gone, so an intent whose delete
 * failed keeps its row and stays a retry target.
 */
export const completeCaseLawCorpusUploadIntentCleanups = async ({
  intentIds,
  scopedDb,
}: {
  intentIds: readonly SafeId<"caseLawCorpusUploadIntent">[];
  scopedDb: ScopedDb;
}): Promise<void> => {
  if (intentIds.length === 0) {
    return;
  }
  await scopedDb(async (tx) => {
    await tx
      .delete(caseLawCorpusUploadIntents)
      .where(
        and(
          inArray(caseLawCorpusUploadIntents.id, [...intentIds]),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          ),
        ),
      );
  });
};

export const corpusUploadCleanupDelayMs = (attemptCount: number): number =>
  Math.min(
    CLEANUP_RETRY_UNIT_MS * 2 ** Math.min(attemptCount, 11),
    CLEANUP_RETRY_MAX_DELAY_MS,
  );

type ReconcileCaseLawCorpusUploadIntentsOptions = {
  deleteCorpus?: (
    keys: {
      astKey: string | null;
      sectionsKey: string | null;
      textKey: string | null;
    },
    options?: { signal?: AbortSignal },
  ) => Promise<CorpusDeleteOutcome>;
  limit: number;
  safeDb: SafeDb;
  signal?: AbortSignal;
};

export type ReconcileCaseLawCorpusUploadIntentsResult = {
  claimed: number;
  cleaned: number;
};

/**
 * Bounded durable cleanup worker. Expired active leases become cleanup work;
 * locking candidates with SKIP LOCKED makes scheduler replicas converge
 * without duplicate ownership.
 */
export const reconcileCaseLawCorpusUploadIntents = async ({
  deleteCorpus = deleteCorpusDocument,
  limit,
  safeDb,
  signal,
}: ReconcileCaseLawCorpusUploadIntentsOptions): Promise<ReconcileCaseLawCorpusUploadIntentsResult> => {
  if (!Number.isInteger(limit) || limit < 1) {
    return panic("Corpus upload cleanup limit must be a positive integer");
  }
  signal?.throwIfAborted();
  const now = new Date();
  const claimedResult = await safeDb(async (tx) => {
    const rows = await tx
      .select({
        id: caseLawCorpusUploadIntents.id,
        decisionId: caseLawCorpusUploadIntents.decisionId,
        textKey: caseLawCorpusUploadIntents.textS3Key,
        sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
        astKey: caseLawCorpusUploadIntents.astS3Key,
        cleanupAttemptCount: caseLawCorpusUploadIntents.cleanupAttemptCount,
      })
      .from(caseLawCorpusUploadIntents)
      .where(
        or(
          and(
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
            ),
            lte(caseLawCorpusUploadIntents.nextCleanupAt, now),
          ),
          and(
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
            ),
            lte(caseLawCorpusUploadIntents.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(
        asc(
          sql`COALESCE(${caseLawCorpusUploadIntents.nextCleanupAt}, ${caseLawCorpusUploadIntents.leaseExpiresAt})`,
        ),
        asc(caseLawCorpusUploadIntents.id),
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    if (rows.length > 0) {
      await tx
        .update(caseLawCorpusUploadIntents)
        .set({
          status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          cleanupAttemptCount: sql`${caseLawCorpusUploadIntents.cleanupAttemptCount} + 1`,
          nextCleanupAt: sql`now() + (
            LEAST(
              ${CLEANUP_RETRY_MAX_DELAY_MS},
              ${CLEANUP_RETRY_UNIT_MS} * POWER(
                2,
                LEAST(${caseLawCorpusUploadIntents.cleanupAttemptCount}, 11)
              )
            ) * interval '1 millisecond'
          )`,
        })
        .where(
          inArray(
            caseLawCorpusUploadIntents.id,
            rows.map(({ id }) => id),
          ),
        );
    }
    return rows;
  });
  if (Result.isError(claimedResult)) {
    throw claimedResult.error;
  }

  if (claimedResult.value.length === 0) {
    return { claimed: 0, cleaned: 0 };
  }

  const cleanupResult = await safeDb(async (tx) => {
    signal?.throwIfAborted();
    const decisionIds = claimedResult.value.map(({ decisionId }) => decisionId);
    const decisions = await tx
      .select({
        id: caseLawDecisions.id,
        textKey: caseLawDecisions.textS3Key,
        sectionsKey: caseLawDecisions.normalizedS3Key,
        astKey: caseLawDecisions.astS3Key,
      })
      .from(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, decisionIds))
      .for("update");
    const activeIntents = await tx
      .select({
        textKey: caseLawCorpusUploadIntents.textS3Key,
        sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
        astKey: caseLawCorpusUploadIntents.astS3Key,
      })
      .from(caseLawCorpusUploadIntents)
      .where(
        and(
          inArray(caseLawCorpusUploadIntents.decisionId, decisionIds),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
          ),
        ),
      );

    const currentKeys = new Set(
      decisions.flatMap(({ astKey, sectionsKey, textKey }) =>
        [astKey, sectionsKey, textKey].filter(
          (key): key is string => key !== null,
        ),
      ),
    );
    const activeKeys = new Set(
      activeIntents.flatMap(({ astKey, sectionsKey, textKey }) => [
        astKey,
        sectionsKey,
        textKey,
      ]),
    );
    const corpusIoOptions = signal === undefined ? {} : { signal };
    const cleanupResults = await Promise.all(
      claimedResult.value.map(async (row) => {
        const plan = planCorpusUploadIntentCleanup(
          {
            astKey: row.astKey,
            sectionsKey: row.sectionsKey,
            textKey: row.textKey,
          },
          currentKeys,
          activeKeys,
        );
        if (plan.type === "defer") {
          return null;
        }
        try {
          await deleteCorpus(plan.keys, corpusIoOptions);
          return row.id;
        } catch (error) {
          captureError(error, {
            corpusUploadIntentId: row.id,
            step: "reconcileCaseLawCorpusUploadIntents.delete",
          });
          return null;
        }
      }),
    );
    const cleanedIds = cleanupResults.filter(
      (id): id is SafeId<"caseLawCorpusUploadIntent"> => id !== null,
    );
    if (cleanedIds.length === 0) {
      return 0;
    }
    const removed = await tx
      .delete(caseLawCorpusUploadIntents)
      .where(
        and(
          inArray(caseLawCorpusUploadIntents.id, cleanedIds),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          ),
        ),
      )
      .returning({ id: caseLawCorpusUploadIntents.id });
    return removed.length;
  });
  if (Result.isError(cleanupResult)) {
    throw cleanupResult.error;
  }
  const cleaned = cleanupResult.value;

  return { claimed: claimedResult.value.length, cleaned };
};
