import { Result, panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  SUPPLEMENT_ABSORB_FAILED,
  absorbComposedSupplementRows,
} from "@/api/handlers/case-law/ingestion/pipeline/composed-supplements";
import { enqueueCorpusMirror } from "@/api/handlers/case-law/ingestion/pipeline/decision-corpus";
import {
  classifyObservation,
  resolveExistingDecisionPolicy,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-existing";
import {
  observeDecision,
  resolveDecisionIdentityTx,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import { planDecisionWrite } from "@/api/handlers/case-law/ingestion/pipeline/decision-plan";
import {
  acquireSourceRawArtifact,
  recordAbandonedRawWrite,
  withSourceRawRetry,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-raw";
import type { RawWriteState } from "@/api/handlers/case-law/ingestion/pipeline/decision-raw";
import {
  isConcurrentIdentityInsert,
  writeDecisionRowWithSlug,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-row";
import type { DecisionRowWrite } from "@/api/handlers/case-law/ingestion/pipeline/decision-row-context";
import {
  CASE_LAW_CORPUS_DEPENDENCIES,
  CASE_LAW_JUDGE_DEPENDENCIES,
} from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import {
  CONTENTION_RECONCILIATION,
  DECISION_REFRESH,
  DECISION_ROW_WRITE_STATUS,
  RECONCILE_CONTENTION,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import type {
  AttemptStep,
  DecisionRowWriteStatus,
  ProcessDecisionAttemptOptions,
  ProcessDecisionOptions,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import {
  composeDecisionWithSupplements,
  type StoredSupplement,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

type SettleRowWriteStatusOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  composedSupplements: StoredSupplement[];
  writeStatus: DecisionRowWriteStatus;
};

/**
 * What the row write's status means for the attempt. Null once the row is
 * written and the attempt goes on to its corpus mirror.
 */
const settleRowWriteStatus = async ({
  scopedDb,
  sourceId,
  decisionId,
  composedSupplements,
  writeStatus,
}: SettleRowWriteStatusOptions): Promise<AttemptStep | null> => {
  switch (writeStatus) {
    case DECISION_ROW_WRITE_STATUS.APPLIED: {
      // The judgment itself is written; a row left standing is not a reason
      // to observe it again. The reconciliation lists that supplement again.
      const absorbed = await absorbComposedSupplementRows({
        scopedDb,
        sourceId,
        judgmentId: decisionId,
        supplements: composedSupplements,
      });
      if (absorbed.type === "incomplete") {
        logger.warn(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId: decisionId,
          "error.detail": `left for reconciliation: ${absorbed.sourceDocumentIds.join(", ")}`,
        });
      }
      return null;
    }
    case DECISION_ROW_WRITE_STATUS.SUPPLEMENTS_MOVED:
      return RECONCILE_CONTENTION;
    case DECISION_ROW_WRITE_STATUS.WINNER_PENDING:
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: false,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      };
    case DECISION_ROW_WRITE_STATUS.WINNER_REDACTED:
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: false,
        searchVectorFailed: false,
      };
    case DECISION_ROW_WRITE_STATUS.WINNER_SETTLED:
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: false,
        searchVectorFailed: false,
      };
    case DECISION_ROW_WRITE_STATUS.STALE_PAYLOAD:
      return RECONCILE_CONTENTION;
    default:
      writeStatus satisfies never;
      return panic(`Unhandled write status: ${String(writeStatus)}`);
  }
};

/**
 * One pass over a decision: resolve its identity, settle what an existing
 * row makes of it, store its raw payload, plan and write its row, then queue
 * its corpus mirror. Each phase answers the attempt's outcome, or a
 * contention the caller reconciles by running the attempt again.
 */
const runDecisionAttempt = async ({
  input,
  judges,
  sourceId,
  scopedDb,
  observedAt,
  observationOrder,
  refresh,
  corpus,
  corpusBatch,
  polarityRules,
}: ProcessDecisionAttemptOptions): Promise<AttemptStep> => {
  const observation = observeDecision({ input, sourceId });
  const proposedDecisionId = createSafeId<"caseLawDecision">();

  // Opened before the read below that proves the decision is not erased, so
  // every raw write this attempt makes starts within the window of that
  // read, and an erasure's settled sweep comes after all of them.
  const rawWrites: RawWriteState = {
    window: openRawSourceWriteWindow(),
    attempted: false,
  };

  const identity = await scopedDb(
    async (tx) =>
      await resolveDecisionIdentityTx(tx, {
        ...observation,
        sourceId,
        proposedDecisionId,
      }),
  );
  const { existing, decisionId, composition } = identity;

  if (existing?.redactedAt) {
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      inserted: false,
      searchVectorFailed: false,
    };
  }

  const composedSupplements =
    composition === null ? [] : composition.supplements;
  const result = composeDecisionWithSupplements(
    observation.observed,
    composedSupplements,
  );
  const shape = classifyObservation({ result, existing });

  const existingPolicyOutcome = await resolveExistingDecisionPolicy({
    scopedDb,
    existing,
    result,
    shape,
    observedAt,
    observationOrder,
    refresh,
  });
  if (existingPolicyOutcome !== null) {
    return existingPolicyOutcome;
  }

  const sourceRawArtifact = await acquireSourceRawArtifact({
    result,
    existing,
    preservesExistingDetail: shape.preservesExistingDetail,
    sourceId,
    decisionId,
    rawWrites,
  });
  if (sourceRawArtifact.type === "retry") {
    await recordAbandonedRawWrite({
      scopedDb,
      existing,
      rawWrites,
      decisionId,
      sourceId,
    });
    return sourceRawArtifact.outcome;
  }
  const rawArtifact = sourceRawArtifact.artifact;

  const plan = await planDecisionWrite({
    result,
    existing,
    decisionId,
    sourceId,
    scopedDb,
    corpus,
    incomingCarriesDocument: shape.incomingCarriesDocument,
    polarityRules,
  });

  const write: DecisionRowWrite = {
    ...identity,
    persistedDecisionDate: observation.persistedDecisionDate,
    sourceId,
    decisionId,
    result,
    composedSupplements,
    observedAt,
    observationOrder,
    shape,
    plan,
    rawArtifact,
    rawWrites,
    judges,
  };
  const rowWrite = await writeDecisionRowWithSlug(scopedDb, write);

  if (Result.isError(rowWrite)) {
    await recordAbandonedRawWrite({
      scopedDb,
      existing,
      rawWrites,
      decisionId,
      sourceId,
    });
    if (isConcurrentIdentityInsert(rowWrite.error)) {
      return RECONCILE_CONTENTION;
    }
    throw rowWrite.error;
  }

  const settled = await settleRowWriteStatus({
    scopedDb,
    sourceId,
    decisionId,
    composedSupplements,
    writeStatus: rowWrite.value,
  });
  if (settled !== null) {
    return settled;
  }

  const flushed = await enqueueCorpusMirror({
    scopedDb,
    write,
    corpus,
    corpusBatch,
  });
  if (flushed !== null) {
    return flushed;
  }

  // Search indexing (tsvector) is handled by a background
  // backfill loop so the slow to_tsvector + unaccent computation
  // doesn't block cursor advancement. New decisions become
  // searchable within ~30s of insertion.

  return withSourceRawRetry(rawArtifact.s3UploadFailed, {
    status: PROCESS_DECISION_STATUS.COMPLETE,
    inserted: true,
    searchVectorFailed: false,
  });
};

/**
 * Insert a single decision and its citations into the database.
 * Skips duplicates based on sourceHash.
 *
 * A contention a phase reports is reconciled once, by running the attempt
 * again; on that retry it holds the page's cursor instead.
 */
const processDecisionAttempt = async (
  options: ProcessDecisionAttemptOptions,
): Promise<ProcessResult> => {
  const step = await runDecisionAttempt(options);
  if (step.status !== RECONCILE_CONTENTION.status) {
    return step;
  }
  if (options.contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
    return {
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      inserted: false,
      reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
    };
  }
  return await processDecisionAttempt({
    ...options,
    contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
  });
};

export const processDecision = async ({
  refresh = DECISION_REFRESH.WHEN_SOURCE_CHANGED,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
  judges = CASE_LAW_JUDGE_DEPENDENCIES,
  ...options
}: ProcessDecisionOptions): Promise<ProcessResult> =>
  await processDecisionAttempt({
    ...options,
    contentionReconciliation: CONTENTION_RECONCILIATION.INITIAL,
    refresh,
    corpus,
    judges,
  });
