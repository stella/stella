import { Result, panic } from "better-result";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisionSourceIdentities } from "@/api/db/schema";
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
import { REPUBLISHED_RULING_OUTCOME } from "@/api/handlers/case-law/ingestion/pipeline/ruling-identity-match";
import type { RepublishedRulingMatch } from "@/api/handlers/case-law/ingestion/pipeline/ruling-identity-match";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
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
import { lockUnredactedCitingDecisions } from "@/api/lib/db/aggregate-lock";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

type RecordSourceIdentityRawOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  sourceDocumentId: string | undefined;
  decisionId: SafeId<"caseLawDecision">;
  rawArtifact: {
    sourceRawS3Key: string | null;
    sourceRawContentType: string | null;
  };
  sourceUrl: string | undefined;
  observedAt: Date;
};

export const recordSourceIdentityRaw = async ({
  scopedDb,
  sourceId,
  sourceDocumentId,
  decisionId,
  rawArtifact,
  sourceUrl,
  observedAt,
}: RecordSourceIdentityRawOptions): Promise<void> => {
  if (sourceDocumentId === undefined) {
    return;
  }
  await scopedDb(async (tx) => {
    const writable = await lockUnredactedCitingDecisions({
      tx,
      decisionIds: [decisionId],
      lock: true,
    });
    if (!writable.has(decisionId)) {
      return;
    }
    // audit: skip - publisher provenance for public case-law data
    await tx
      .update(caseLawDecisionSourceIdentities)
      .set({
        sourceRawS3Key: rawArtifact.sourceRawS3Key,
        sourceRawContentType: rawArtifact.sourceRawContentType,
        sourceUrl: sourceUrl ?? null,
        sourceObservedAt: observedAt,
      })
      .where(
        and(
          eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
          eq(caseLawDecisionSourceIdentities.decisionId, decisionId),
          eq(
            caseLawDecisionSourceIdentities.sourceDocumentId,
            sourceDocumentId,
          ),
          // An attempt that finishes late must not replace a newer observation.
          or(
            isNull(caseLawDecisionSourceIdentities.sourceObservedAt),
            lte(
              caseLawDecisionSourceIdentities.sourceObservedAt,
              sql`${observedAt.toISOString()}::timestamptz`,
            ),
          ),
        ),
      );
  });
};

type SettleRepublishedLinkOptions = RecordSourceIdentityRawOptions & {
  republished: ReturnType<typeof matchRepublishedLink>;
  s3UploadFailed: boolean;
};

const matchRepublishedLink = (
  identity: Awaited<ReturnType<typeof resolveDecisionIdentityTx>>,
) =>
  identity.republished?.type === REPUBLISHED_RULING_OUTCOME.LINKED
    ? identity.republished
    : undefined;

const resolveNonRepublishedExistingDecisionPolicy = async (
  republished: ReturnType<typeof matchRepublishedLink>,
  options: Parameters<typeof resolveExistingDecisionPolicy>[0],
) =>
  republished === undefined
    ? await resolveExistingDecisionPolicy(options)
    : null;

const settleRepublishedLink = async ({
  republished,
  s3UploadFailed,
  ...raw
}: SettleRepublishedLinkOptions): Promise<ProcessResult | null> => {
  if (republished === undefined) {
    return null;
  }
  await recordSourceIdentityRaw(raw);
  return withSourceRawRetry(s3UploadFailed, {
    status: PROCESS_DECISION_STATUS.COMPLETE,
    inserted: false,
    searchVectorFailed: false,
    republished,
  });
};

const completedInsert = (
  s3UploadFailed: boolean,
  republished: RepublishedRulingMatch | undefined,
): ProcessResult =>
  withSourceRawRetry(s3UploadFailed, {
    status: PROCESS_DECISION_STATUS.COMPLETE,
    inserted: true,
    searchVectorFailed: false,
    ...(republished === undefined ? {} : { republished }),
  });

const recordAppliedIdentityRaw = async (
  writeStatus: DecisionRowWriteStatus,
  options: RecordSourceIdentityRawOptions,
): Promise<void> => {
  if (writeStatus === DECISION_ROW_WRITE_STATUS.APPLIED) {
    await recordSourceIdentityRaw(options);
  }
};

const redactedDecisionOutcome = (
  redactedAt: Date | null | undefined,
): ProcessResult | null =>
  redactedAt
    ? {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: false,
        searchVectorFailed: false,
      }
    : null;

type SettleRowWriteStatusOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  composedSupplements: StoredSupplement[];
  observationOrder: bigint;
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
  observationOrder,
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
        observationOrder,
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
  metadataUrlSchema,
  statedEcliIdentity,
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
  signal,
  s3Policy,
}: ProcessDecisionAttemptOptions): Promise<AttemptStep> => {
  signal?.throwIfAborted();
  const observation = observeDecision({ input, sourceId, metadataUrlSchema });
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
        statedEcliIdentity,
        proposedDecisionId,
      }),
  );
  const { existing, decisionId, composition } = identity;
  const redacted = redactedDecisionOutcome(existing?.redactedAt);
  if (redacted !== null) {
    return redacted;
  }
  const composedSupplements =
    composition === null ? [] : composition.supplements;
  const result = composeDecisionWithSupplements({
    judgment: observation.observed,
    supplements: composedSupplements,
    metadataUrlSchema,
  });
  const shape = classifyObservation({ result, existing });
  const republished = matchRepublishedLink(identity);

  const existingPolicyOutcome =
    await resolveNonRepublishedExistingDecisionPolicy(republished, {
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
  signal?.throwIfAborted();
  const sourceRawArtifact = await acquireSourceRawArtifact({
    ...(signal === undefined ? {} : { signal }),
    ...(s3Policy === undefined ? {} : { s3Policy }),
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

  const republishedLink = await settleRepublishedLink({
    republished,
    s3UploadFailed: rawArtifact.s3UploadFailed,
    scopedDb,
    sourceId,
    sourceDocumentId: result.sourceDocumentId,
    decisionId,
    rawArtifact,
    sourceUrl: result.sourceUrl,
    observedAt,
  });
  if (republishedLink !== null) {
    return republishedLink;
  }

  const attempted = await Result.tryPromise({
    try: async () => {
      const planned = await planDecisionWrite({
        ...(signal === undefined ? {} : { signal }),
        ...(s3Policy === undefined ? {} : { s3Policy }),
        metadataUrlSchema,
        result,
        existing,
        decisionId,
        sourceId,
        scopedDb,
        corpus,
        incomingCarriesDocument: shape.incomingCarriesDocument,
        polarityRules,
      });
      if (planned.isErr()) {
        return Result.err(planned.error);
      }
      const plan = planned.value;
      if ("status" in plan) {
        return Result.ok(RECONCILE_CONTENTION);
      }
      signal?.throwIfAborted();
      const write: DecisionRowWrite = {
        ...(signal === undefined ? {} : { signal }),
        ...(s3Policy === undefined ? {} : { s3Policy }),
        ...identity,
        persistedDecisionDate: observation.persistedDecisionDate,
        sourceId,
        decisionId,
        result: plan.preparedResult,
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
        return Result.err(rowWrite.error);
      }
      return Result.ok({ write, writeStatus: rowWrite.value });
    },
    catch: (cause) => cause,
  });
  const rowWrite = attempted.andThen((outcome) => outcome);

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

  if ("status" in rowWrite.value) {
    await recordAbandonedRawWrite({
      scopedDb,
      existing,
      rawWrites,
      decisionId,
      sourceId,
    });
    return RECONCILE_CONTENTION;
  }
  const { write, writeStatus } = rowWrite.value;

  await recordAppliedIdentityRaw(writeStatus, {
    scopedDb,
    sourceId,
    sourceDocumentId: identity.persistedSourceDocumentId,
    decisionId,
    rawArtifact,
    sourceUrl: result.sourceUrl,
    observedAt,
  });

  const settled = await settleRowWriteStatus({
    scopedDb,
    sourceId,
    decisionId,
    composedSupplements,
    observationOrder,
    writeStatus,
  });
  if (settled !== null) {
    return settled;
  }

  signal?.throwIfAborted();
  const flushed = await enqueueCorpusMirror({
    scopedDb,
    write,
    corpus,
    corpusBatch,
  });
  if (flushed !== null) {
    return flushed;
  }

  return completedInsert(rawArtifact.s3UploadFailed, identity.republished);
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

export const processDecision = async (
  {
    refresh = DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus = CASE_LAW_CORPUS_DEPENDENCIES,
    judges = CASE_LAW_JUDGE_DEPENDENCIES,
    ...options
  }: ProcessDecisionOptions,
  resolveSourceContract: SourceContractResolver = createSourceContractResolver(
    options.scopedDb,
  ),
): Promise<ProcessResult> => {
  const { metadataUrlSchema, statedEcliIdentity } = await resolveSourceContract(
    options.sourceId,
  );
  return await processDecisionAttempt({
    ...options,
    metadataUrlSchema,
    statedEcliIdentity,
    contentionReconciliation: CONTENTION_RECONCILIATION.INITIAL,
    refresh,
    corpus,
    judges,
  });
};
