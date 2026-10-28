import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type {
  DecisionTextFailure,
  DecisionTextState,
} from "@stll/api-contract/case-law-fulltext-state";
import { CASE_LAW_TEXT_STATUS } from "@stll/api-contract/case-law-text-status";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { eligibleDecisionTextSql } from "@/api/lib/case-law/fulltext-eligibility-sql";
import {
  decisionTextObservationState,
  failedDecisionText,
  FULLTEXT_RECOVERY_LIMITS,
  pendingDecisionText,
  readDecisionTextState,
  textFailureFromObservation,
} from "@/api/lib/case-law/fulltext-state";
import {
  lockCaseLawDecisionRows,
  withSkipLockedBatch,
} from "@/api/lib/db/aggregate-lock";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";
import type { WriteCorpusResult } from "@/api/lib/legal-search/corpus-storage";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

/** Only this owner installs proofs; the database invalidates them on payload writes. */
const eligible = eligibleDecisionTextSql(caseLawDecisions);

export type DecisionTextPayloadWrite =
  | { type: "postgres"; payload: CorpusPayload }
  | { type: "corpus"; payload: CorpusPayload; written: WriteCorpusResult }
  | { type: "preserved" };

type RecordDecisionTextObservationOptions = {
  decisionId: SafeId<"caseLawDecision">;
  payloadWrite: DecisionTextPayloadWrite;
  caseNumberType: DecisionPrimaryReferenceType;
  metadata: Record<string, unknown>;
  now: Date;
};

/** Mandatory transaction step, separate from best-effort write extensions. */
export const recordDecisionTextObservationTx = async (
  tx: Pick<Transaction, "select" | "update">,
  {
    decisionId,
    payloadWrite,
    caseNumberType,
    metadata,
    now,
  }: RecordDecisionTextObservationOptions,
): Promise<void> => {
  const observation =
    payloadWrite.type === "preserved"
      ? null
      : decisionTextObservationState({
          payload: payloadWrite.payload,
          caseNumberType,
          storage: payloadWrite.type,
          now,
          metadata,
          attemptCount: 0,
        });
  const proof =
    observation?.status === CASE_LAW_TEXT_STATUS.STORED ? observation : null;
  if (proof !== null) {
    if (
      payloadWrite.type === "corpus" &&
      proof.contentHash !== payloadWrite.written.contentHash
    ) {
      return panic(
        "Corpus full-text proof does not match its acknowledged payload",
      );
    }
    // audit: skip — public corpus ingestion; proof is part of the payload transaction.
    await tx
      .update(caseLawDecisions)
      .set({ textState: proof })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          eligible,
          payloadWrite.type === "corpus"
            ? eq(caseLawDecisions.contentHash, proof.contentHash)
            : undefined,
        ),
      );
    return;
  }
  const cause = textFailureFromObservation(metadata);
  if (cause === null) {
    // The database retains a previous proof or creates durable pending work.
    return;
  }
  const current = (
    await tx
      .select({ textState: caseLawDecisions.textState })
      .from(caseLawDecisions)
      .where(and(eq(caseLawDecisions.id, decisionId), eligible))
      .limit(1)
  ).at(0);
  if (current === undefined) {
    return;
  }
  const state = readDecisionTextState(current.textState);
  if (state?.status === CASE_LAW_TEXT_STATUS.STORED) {
    return;
  }
  const attempts =
    state?.status === CASE_LAW_TEXT_STATUS.FETCH_PENDING ||
    state?.status === CASE_LAW_TEXT_STATUS.FETCH_FAILED
      ? Math.max(state.attemptCount, 1)
      : 1;
  // audit: skip — durable typed outcome of a public publisher read.
  await tx
    .update(caseLawDecisions)
    .set({
      textState: failedDecisionText({
        now,
        attemptCount: attempts,
        cause,
        retryFloorMs: FULLTEXT_RECOVERY_LIMITS.INITIAL_RETRY_MS,
      }),
    })
    .where(and(eq(caseLawDecisions.id, decisionId), eligible));
};

type RecordDecisionTextFailureOptions = {
  decisionId: SafeId<"caseLawDecision">;
  sourceHash: string | null;
  attemptCount: number;
  cause: DecisionTextFailure;
  now: Date;
  retryFloorMs: number;
};

/** A failed refresh never retracts a readable document another path stored. */
export const recordDecisionTextFailureTx = async (
  tx: Pick<Transaction, "execute" | "select" | "update">,
  {
    decisionId,
    sourceHash,
    attemptCount,
    cause,
    now,
    retryFloorMs,
  }: RecordDecisionTextFailureOptions,
): Promise<void> => {
  const where = and(
    eq(caseLawDecisions.id, decisionId),
    eligible,
    sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${sourceHash}`,
  );
  await lockCaseLawDecisionRows({ tx, decisionIds: [decisionId] });
  const current = (
    await tx
      .select({ textState: caseLawDecisions.textState })
      .from(caseLawDecisions)
      .where(where)
      .limit(1)
  ).at(0);
  if (current === undefined) {
    return;
  }
  const state = readDecisionTextState(current.textState);
  if (state?.status === CASE_LAW_TEXT_STATUS.STORED) {
    return;
  }
  // audit: skip — same transaction as the fenced public document-fetch outcome.
  await tx
    .update(caseLawDecisions)
    .set({
      textState: failedDecisionText({
        now,
        attemptCount: Math.max(attemptCount, 1),
        cause,
        retryFloorMs,
        ...(state?.status === CASE_LAW_TEXT_STATUS.FETCH_PENDING ||
        state?.status === CASE_LAW_TEXT_STATUS.FETCH_FAILED
          ? { recovery: state.recovery }
          : {}),
      }),
    })
    .where(where);
};

type SourceTextWorkOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
};

/** The indexed null set is its own durable checkpoint; replay consumes no row twice. */
export const adoptLegacyDecisionTextStates = async ({
  scopedDb,
  sourceId,
  now,
}: SourceTextWorkOptions): Promise<number> =>
  await withSkipLockedBatch({
    database: { transaction: scopedDb },
    limit: FULLTEXT_RECOVERY_LIMITS.ADOPTION_BATCH,
    select: (tx) =>
      tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eligible,
            isNull(caseLawDecisions.textState),
          ),
        )
        .orderBy(asc(caseLawDecisions.id))
        .limit(FULLTEXT_RECOVERY_LIMITS.ADOPTION_BATCH)
        .$dynamic(),
    run: async (tx, rows) => {
      if (rows.length === 0) {
        return 0;
      }
      // audit: skip — bounded adoption of legacy public corpus rows, no payload mutation.
      const adopted = await tx
        .update(caseLawDecisions)
        .set({
          textState: pendingDecisionText({
            now,
            attemptCount: 0,
            lastAttemptAt: null,
            delayMs: 0,
          }),
        })
        .where(
          and(
            inArray(
              caseLawDecisions.id,
              rows.map(({ id }) => id),
            ),
            isNull(caseLawDecisions.textState),
            eligible,
          ),
        )
        .returning({ id: caseLawDecisions.id });
      return adopted.length;
    },
  });

/** Recheck acknowledged objects too: a persisted proof is not permanent durability. */
export const scheduleStaleDecisionTextProof = async ({
  scopedDb,
  sourceId,
  now,
}: SourceTextWorkOptions): Promise<number> => {
  const before = new Date(
    now.getTime() - FULLTEXT_RECOVERY_LIMITS.STORED_VERIFICATION_MS,
  ).toISOString();
  return await withSkipLockedBatch({
    database: { transaction: scopedDb },
    limit: 1,
    select: (tx) =>
      tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eligible,
            sql`${caseLawDecisions.textState} ->> 'status' = 'stored'`,
            sql`${caseLawDecisions.textState} ->> 'verifiedAt' < ${before}`,
          ),
        )
        .orderBy(
          sql`${caseLawDecisions.textState} ->> 'verifiedAt'`,
          asc(caseLawDecisions.id),
        )
        .limit(1)
        .$dynamic(),
    run: async (tx, rows) => {
      const row = rows.at(0);
      if (row === undefined) {
        return 0;
      }
      // audit: skip — bounded periodic reconciliation of a public corpus proof.
      await tx
        .update(caseLawDecisions)
        .set({
          textState: pendingDecisionText({
            now,
            attemptCount: 0,
            lastAttemptAt: null,
            delayMs: 0,
          }),
        })
        .where(and(eq(caseLawDecisions.id, row.id), eligible));
      return 1;
    },
  });
};

/** A claim expires durably if its worker dies; no external I/O holds this transaction. */
export const claimDecisionTextWork = async ({
  scopedDb,
  sourceId,
  now,
}: SourceTextWorkOptions) =>
  await withSkipLockedBatch({
    database: { transaction: scopedDb },
    limit: FULLTEXT_RECOVERY_LIMITS.VERIFICATION_BATCH,
    select: (tx) =>
      tx
        .select({
          id: caseLawDecisions.id,
          sourceId: caseLawDecisions.sourceId,
          textState: caseLawDecisions.textState,
          sourceHash: caseLawDecisions.sourceHash,
          sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
          caseNumber: caseLawDecisions.caseNumber,
          caseNumberType: caseLawDecisions.caseNumberType,
          sheetNumber: caseLawDecisions.sheetNumber,
          sourceDocumentId: caseLawDecisions.sourceDocumentId,
          decisionDate: caseLawDecisions.decisionDate,
          country: caseLawDecisions.country,
          language: caseLawDecisions.language,
          court: caseLawDecisions.court,
          ecli: caseLawDecisions.ecli,
          decisionType: caseLawDecisions.decisionType,
          sourceUrl: caseLawDecisions.sourceUrl,
          documentUrl: caseLawDecisions.documentUrl,
          metadata: caseLawDecisions.metadata,
          fulltext: caseLawDecisions.fulltext,
          documentAst: caseLawDecisions.documentAst,
          sections: caseLawDecisions.sections,
          contentHash: caseLawDecisions.contentHash,
          textS3Key: caseLawDecisions.textS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          astS3Key: caseLawDecisions.astS3Key,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          sourceRawContentType: caseLawDecisions.sourceRawContentType,
          sourceRaw: caseLawDecisions.sourceRaw,
        })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eligible,
            sql`${caseLawDecisions.textState} ->> 'status' IN ('fetch_pending', 'fetch_failed')`,
            sql`${caseLawDecisions.textState} ->> 'nextAttemptAt' <= ${now.toISOString()}`,
          ),
        )
        .orderBy(
          sql`${caseLawDecisions.textState} ->> 'nextAttemptAt'`,
          asc(caseLawDecisions.id),
        )
        .limit(FULLTEXT_RECOVERY_LIMITS.VERIFICATION_BATCH)
        .$dynamic(),
    run: async (tx, rows) => {
      const claimed = [];
      for (const row of rows) {
        const previous = readDecisionTextState(row.textState);
        if (
          previous?.status !== CASE_LAW_TEXT_STATUS.FETCH_PENDING &&
          previous?.status !== CASE_LAW_TEXT_STATUS.FETCH_FAILED
        ) {
          return panic(
            "Full-text work query selected a state outside its queue",
          );
        }
        const state = pendingDecisionText({
          now,
          attemptCount: previous.attemptCount + 1,
          lastAttemptAt: now.toISOString(),
          delayMs: FULLTEXT_RECOVERY_LIMITS.CLAIM_MS,
          recovery: previous.recovery,
        });
        claimed.push({ ...row, textState: state });
      }
      if (claimed.length === 0) {
        return claimed;
      }
      const transitions = claimed.map(
        ({ id, textState }) =>
          sql`WHEN ${id}::uuid THEN ${JSON.stringify(textState)}::text::jsonb`,
      );
      // audit: skip — one atomic batch claim of bounded public corpus recovery work.
      await tx
        .update(caseLawDecisions)
        .set({
          textState: sqlCaseFragment({
            branches: transitions,
            fallback: sql`${caseLawDecisions.textState}`,
            operand: sql`${caseLawDecisions.id}`,
          }),
        })
        .where(
          inArray(
            caseLawDecisions.id,
            claimed.map(({ id }) => id),
          ),
        );
      return claimed;
    },
  });

export type ClaimedDecisionTextWork = Awaited<
  ReturnType<typeof claimDecisionTextWork>
>[number];

type SettleDecisionTextWorkOptions = {
  scopedDb: ScopedDb;
  claimed: ClaimedDecisionTextWork;
  state: DecisionTextState;
  /** A normal ingestion write may have advanced this worker's observation. */
  observationOrder: bigint | null;
};

/** Never overwrite a later source observation, redaction, or another claim. */
export const settleDecisionTextWork = async ({
  scopedDb,
  claimed,
  state,
  observationOrder,
}: SettleDecisionTextWorkOptions): Promise<boolean> =>
  await scopedDb(async (tx) => {
    // audit: skip — fenced completion of a public full-text recovery attempt.
    const rows = await tx
      .update(caseLawDecisions)
      .set({ textState: state })
      .where(
        and(
          eq(caseLawDecisions.id, claimed.id),
          eligible,
          sql`${caseLawDecisions.sourceObservationOrder} IS NOT DISTINCT FROM ${observationOrder}`,
          observationOrder === claimed.sourceObservationOrder
            ? and(
                sql`${caseLawDecisions.textState} = ${JSON.stringify(claimed.textState)}::text::jsonb`,
                sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${claimed.sourceHash}`,
              )
            : undefined,
          observationOrder !== claimed.sourceObservationOrder &&
            state.status !== CASE_LAW_TEXT_STATUS.FETCH_PENDING
            ? sql`${caseLawDecisions.textState} ->> 'status' <> 'stored'`
            : undefined,
        ),
      )
      .returning({ id: caseLawDecisions.id });
    return rows.length > 0;
  });
