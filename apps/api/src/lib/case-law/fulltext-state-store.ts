import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  DECISION_TEXT_FAILURE,
  DECISION_TEXT_RECOVERY,
  decisionTextStateSchema,
} from "@stll/api-contract/case-law-fulltext-state";
import type {
  DecisionTextFailure,
  DecisionTextRecovery,
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
  DECISION_TEXT_RECOVERY_FAILURE,
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
import { compareAndSetStructuredState } from "@/api/lib/db/transitions";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";
import type { WriteCorpusResult } from "@/api/lib/legal-search/corpus-storage";

/** Only this owner installs proofs; the database invalidates them on payload writes. */
const eligible = eligibleDecisionTextSql(caseLawDecisions);

type WriteDecisionTextStatesOptions = {
  tx: Pick<Transaction, "update">;
  rows: readonly { id: SafeId<"caseLawDecision">; state: DecisionTextState }[];
  fence: SQL | undefined;
};
/** Binds structured transitions to the verified decision-state schema and column. */
const writeDecisionTextStates = async ({
  tx,
  rows,
  fence,
}: WriteDecisionTextStatesOptions) => {
  if (fence === undefined) {
    return panic("A decision text transition requires its fence");
  }
  const result = await compareAndSetStructuredState({
    tx,
    identity: caseLawDecisions.id,
    column: caseLawDecisions.textState,
    schema: decisionTextStateSchema,
    changes: rows.map(({ id, state }) => ({ id, value: state, fence })),
    // The state row records public corpus worker bookkeeping; no user action is performed.
    recordTransitionAuditEvent: async () => await Promise.resolve(),
  });
  switch (result.type) {
    case "updated":
      return result.ids;
    case "stale-fence":
      return [];
    case "schema-rejected":
      return panic(
        "Decision text state factory produced an invalid transition",
      );
    default:
      result satisfies never;
      return panic("Unhandled decision text transition");
  }
};

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
    await writeDecisionTextStates({
      tx,
      rows: [{ id: decisionId, state: proof }],
      fence: and(
        eq(caseLawDecisions.id, decisionId),
        eligible,
        payloadWrite.type === "corpus"
          ? eq(caseLawDecisions.contentHash, proof.contentHash)
          : undefined,
      ),
    });
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
  await writeDecisionTextStates({
    tx,
    rows: [
      {
        id: decisionId,
        state: failedDecisionText({
          now,
          attemptCount: attempts,
          cause,
          retryFloorMs: FULLTEXT_RECOVERY_LIMITS.INITIAL_RETRY_MS,
          ...(state?.status === CASE_LAW_TEXT_STATUS.FETCH_PENDING ||
          state?.status === CASE_LAW_TEXT_STATUS.FETCH_FAILED
            ? { recovery: state.recovery }
            : {}),
        }),
      },
    ],
    fence: and(
      eq(caseLawDecisions.id, decisionId),
      eligible,
      sql`${caseLawDecisions.textState} IS NOT DISTINCT FROM ${JSON.stringify(current.textState)}::text::jsonb`,
    ),
  });
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
  await writeDecisionTextStates({
    tx,
    rows: [
      {
        id: decisionId,
        state: failedDecisionText({
          now,
          attemptCount: Math.max(attemptCount, 1),
          cause,
          retryFloorMs,
          ...(state?.status === CASE_LAW_TEXT_STATUS.FETCH_PENDING ||
          state?.status === CASE_LAW_TEXT_STATUS.FETCH_FAILED
            ? { recovery: state.recovery }
            : {}),
        }),
      },
    ],
    fence: where,
  });
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
      const adopted = await writeDecisionTextStates({
        tx,
        rows: rows.map(({ id }) => ({
          id,
          state: pendingDecisionText({
            now,
            attemptCount: 0,
            lastAttemptAt: null,
            delayMs: 0,
          }),
        })),
        fence: and(
          inArray(
            caseLawDecisions.id,
            rows.map(({ id }) => id),
          ),
          isNull(caseLawDecisions.textState),
          eligible,
        ),
      });
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
      const updated = await writeDecisionTextStates({
        tx,
        rows: [
          {
            id: row.id,
            state: pendingDecisionText({
              now,
              attemptCount: 0,
              lastAttemptAt: null,
              delayMs: 0,
            }),
          },
        ],
        fence: and(eq(caseLawDecisions.id, row.id), eligible),
      });
      return updated.length;
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
          recovery:
            previous.status === CASE_LAW_TEXT_STATUS.FETCH_FAILED &&
            previous.cause.kind === DECISION_TEXT_FAILURE.PARSER_REFUSAL &&
            previous.cause.code ===
              DECISION_TEXT_RECOVERY_FAILURE.LISTING_IDENTITY_NOT_FOUND
              ? { type: DECISION_TEXT_RECOVERY.VERIFY_STORAGE }
              : previous.recovery,
        });
        claimed.push({ ...row, textState: state });
      }
      if (claimed.length === 0) {
        return claimed;
      }
      // audit: skip — one atomic batch claim of bounded public corpus recovery work.
      const updated = await writeDecisionTextStates({
        tx,
        rows: claimed.map(({ id, textState }) => ({ id, state: textState })),
        fence: inArray(
          caseLawDecisions.id,
          claimed.map(({ id }) => id),
        ),
      });
      const updatedIds = new Set(updated);
      return claimed.filter(({ id }) => updatedIds.has(id));
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

const TEXT_WORK_APPLIED = { type: "applied" } as const;
const TEXT_WORK_SUPERSEDED = { type: "superseded" } as const;
const TEXT_WORK_STALE_PROGRESS = { type: "stale-progress" } as const;

const recoveryOf = (
  state: DecisionTextState | null,
): DecisionTextRecovery | null => {
  if (state === null) {
    return null;
  }
  switch (state.status) {
    case CASE_LAW_TEXT_STATUS.FETCH_PENDING:
    case CASE_LAW_TEXT_STATUS.FETCH_FAILED:
      return state.recovery;
    case CASE_LAW_TEXT_STATUS.STORED:
    case CASE_LAW_TEXT_STATUS.PUBLISHER_HAS_NO_TEXT:
    case CASE_LAW_TEXT_STATUS.METADATA_ONLY_BY_SOURCE:
      return null;
    default:
      state satisfies never;
      return panic("Unhandled decision text state");
  }
};

type RecoveryProgressOptions = {
  current: DecisionTextState | null;
  next: DecisionTextState;
};
/** A cursor's slice is opaque; changing it cannot prove forward progress. */
const recoveryProgressIsBehind = ({
  current,
  next,
}: RecoveryProgressOptions): boolean => {
  const previous = recoveryOf(current);
  const requested = recoveryOf(next);
  if (previous === null || requested === null) {
    return false;
  }
  switch (previous.type) {
    case DECISION_TEXT_RECOVERY.VERIFY_STORAGE:
      return false;
    case DECISION_TEXT_RECOVERY.STORED_RAW_RETRY:
      return requested.type === DECISION_TEXT_RECOVERY.VERIFY_STORAGE;
    case DECISION_TEXT_RECOVERY.PUBLISHER_LISTING:
      return (
        requested.type !== DECISION_TEXT_RECOVERY.PUBLISHER_LISTING ||
        requested.slice !== previous.slice ||
        requested.page < previous.page
      );
    default:
      previous satisfies never;
      return panic("Unhandled decision text recovery cursor");
  }
};

/** Never overwrite another claim, source revision, or a later durable checkpoint. */
export const settleDecisionTextWork = async ({
  scopedDb,
  claimed,
  state,
  observationOrder,
}: SettleDecisionTextWorkOptions) =>
  await scopedDb(async (tx) => {
    const fence = and(
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
    );
    await lockCaseLawDecisionRows({ tx, decisionIds: [claimed.id] });
    const current = (
      await tx
        .select({
          state: caseLawDecisions.textState,
          sourceHash: caseLawDecisions.sourceHash,
          observationOrder: caseLawDecisions.sourceObservationOrder,
          matchesFence: sql<boolean>`coalesce(${fence}, false)`,
        })
        .from(caseLawDecisions)
        .where(and(eq(caseLawDecisions.id, claimed.id), eligible))
        .limit(1)
    ).at(0);
    if (current === undefined) {
      return TEXT_WORK_SUPERSEDED;
    }
    const persisted = readDecisionTextState(current.state);
    // Failure time may advance; the claim counter changes only on a new claim.
    const sameAttempt =
      current.observationOrder === observationOrder &&
      (observationOrder !== claimed.sourceObservationOrder ||
        (current.sourceHash === claimed.sourceHash &&
          persisted !== null &&
          (persisted.status === CASE_LAW_TEXT_STATUS.FETCH_PENDING ||
            persisted.status === CASE_LAW_TEXT_STATUS.FETCH_FAILED) &&
          persisted.attemptCount === claimed.textState.attemptCount));
    if (
      sameAttempt &&
      recoveryProgressIsBehind({ current: persisted, next: state })
    ) {
      return TEXT_WORK_STALE_PROGRESS;
    }
    if (!current.matchesFence) {
      return TEXT_WORK_SUPERSEDED;
    }
    // audit: skip — fenced completion of a public full-text recovery attempt.
    const rows = await writeDecisionTextStates({
      tx,
      rows: [{ id: claimed.id, state }],
      fence,
    });
    return rows.length > 0 ? TEXT_WORK_APPLIED : TEXT_WORK_SUPERSEDED;
  });
