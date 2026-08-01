import { Result, panic } from "better-result";
import { and, asc, eq, lte } from "drizzle-orm";

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
  corpusKeys,
  deleteCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type { WriteCorpusResult } from "@/api/lib/legal-search/corpus-storage";

const CLEANUP_RETRY_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_RETRY_UNIT_MS = 60 * 1000;

type CorpusUploadKeys = Pick<
  WriteCorpusResult,
  "astKey" | "sectionsKey" | "textKey"
>;

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
    const reserved = (
      await tx
        .insert(caseLawCorpusUploadIntents)
        .values({
          id: intentId,
          decisionId,
          textS3Key: keys.textKey,
          normalizedS3Key: keys.sectionsKey,
          astS3Key: keys.astKey,
        })
        .onConflictDoNothing()
        .returning({ id: caseLawCorpusUploadIntents.id })
    ).at(0);
    if (!reserved) {
      return { type: "busy" };
    }
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
  apply: (args: {
    tx: Transaction;
    written: WriteCorpusResult;
  }) => Promise<CaseLawCorpusUploadApplyResult>;
  decisionId: SafeId<"caseLawDecision">;
  intentId: SafeId<"caseLawCorpusUploadIntent">;
  preflight: (tx: Transaction) => Promise<boolean>;
  scopedDb: ScopedDb;
  signal?: AbortSignal;
  write: (args: { signal: AbortSignal }) => Promise<WriteCorpusResult>;
};

export type WriteReservedCaseLawCorpusUploadResult =
  | CaseLawCorpusUploadApplyResult
  | { type: "cancelled" };

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
  let writeFailed = false;
  try {
    return await scopedDb(async (tx) => {
      signal?.throwIfAborted();
      const decision = (
        await tx
          .select({ redactedAt: caseLawDecisions.redactedAt })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, decisionId))
          .for("update")
          .limit(1)
      ).at(0);
      if (!decision || decision.redactedAt !== null) {
        return { type: "cancelled" };
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
        return { type: "cancelled" };
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

      let written: WriteCorpusResult;
      try {
        written = await write({
          signal: signal ?? new AbortController().signal,
        });
      } catch (error) {
        writeFailed = true;
        throw error;
      }
      const outcome = await apply({ tx, written });
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
    if (writeFailed) {
      await enqueueCaseLawCorpusUploadIntentCleanup({ intentId, scopedDb });
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

/** Remove a cancelled intent only after its exact-key delete succeeded. */
export const completeCaseLawCorpusUploadIntentCleanup = async ({
  intentId,
  scopedDb,
}: {
  intentId: SafeId<"caseLawCorpusUploadIntent">;
  scopedDb: ScopedDb;
}): Promise<void> => {
  await scopedDb(async (tx) => {
    await tx
      .delete(caseLawCorpusUploadIntents)
      .where(
        and(
          eq(caseLawCorpusUploadIntents.id, intentId),
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
  ) => Promise<void>;
  limit: number;
  safeDb: SafeDb;
  signal?: AbortSignal;
};

export type ReconcileCaseLawCorpusUploadIntentsResult = {
  claimed: number;
  cleaned: number;
};

/**
 * Bounded durable cleanup worker. Locking due rows with SKIP LOCKED makes
 * multiple scheduler replicas converge without duplicate ownership; duplicate
 * S3 DELETEs after a lease-like retry remain safe and idempotent.
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
        textKey: caseLawCorpusUploadIntents.textS3Key,
        sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
        astKey: caseLawCorpusUploadIntents.astS3Key,
        cleanupAttemptCount: caseLawCorpusUploadIntents.cleanupAttemptCount,
      })
      .from(caseLawCorpusUploadIntents)
      .where(
        and(
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          ),
          lte(caseLawCorpusUploadIntents.nextCleanupAt, now),
        ),
      )
      .orderBy(
        asc(caseLawCorpusUploadIntents.nextCleanupAt),
        asc(caseLawCorpusUploadIntents.id),
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    await Promise.all(
      rows.map(
        async (row) =>
          await tx
            .update(caseLawCorpusUploadIntents)
            .set({
              cleanupAttemptCount: row.cleanupAttemptCount + 1,
              nextCleanupAt: new Date(
                now.getTime() +
                  corpusUploadCleanupDelayMs(row.cleanupAttemptCount),
              ),
            })
            .where(eq(caseLawCorpusUploadIntents.id, row.id)),
      ),
    );
    return rows;
  });
  if (Result.isError(claimedResult)) {
    throw claimedResult.error;
  }

  const cleanupResults = await Promise.all(
    claimedResult.value.map(async (row) => {
      signal?.throwIfAborted();
      try {
        await deleteCorpus(
          {
            textKey: row.textKey,
            sectionsKey: row.sectionsKey,
            astKey: row.astKey,
          },
          { signal },
        );
        const removed = await safeDb(
          async (tx) =>
            await tx
              .delete(caseLawCorpusUploadIntents)
              .where(
                and(
                  eq(caseLawCorpusUploadIntents.id, row.id),
                  eq(
                    caseLawCorpusUploadIntents.status,
                    CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
                  ),
                ),
              )
              .returning({ id: caseLawCorpusUploadIntents.id }),
        );
        if (Result.isError(removed)) {
          throw removed.error;
        }
        return removed.value.at(0) ? 1 : 0;
      } catch (error) {
        captureError(error, {
          corpusUploadIntentId: row.id,
          step: "reconcileCaseLawCorpusUploadIntents.delete",
        });
        return 0;
      }
    }),
  );
  const cleaned = cleanupResults.reduce((total, count) => total + count, 0);

  return { claimed: claimedResult.value.length, cleaned };
};
