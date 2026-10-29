import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import {
  absorbComposedSupplementRows,
  SUPPLEMENT_ABSORB_FAILED,
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
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { sourceFingerprintFromStoredRaw as readSourceFingerprintFromStoredRaw } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
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

import { STORED_REPLAY_INPUT_TOKEN } from "./stored-replay-write";

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

const storedInputMatchesDecision = (
  input: ProcessDecisionAttemptOptions["inputProvenance"],
  existing: DecisionRowWrite["existing"],
) =>
  input.type === "observation" ||
  (existing !== undefined &&
    existing.id === input.decisionId &&
    existing.sourceRawS3Key === input.sourceRawS3Key);

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
  inputProvenance,
  judges,
  sourceId,
  scopedDb,
  observedAt,
  observationOrder,
  refresh,
  sourceFingerprintVersion,
  sourceFingerprintFromStoredRaw,
  corpus,
  corpusBatch,
  polarityRules,
  signal,
  s3Policy,
}: ProcessDecisionAttemptOptions): Promise<AttemptStep> => {
  signal?.throwIfAborted();
  const observation = observeDecision({ input, sourceId, metadataUrlSchema });

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
        proposedDecisionId: createSafeId<"caseLawDecision">(),
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

  const composedSupplements = composition?.supplements ?? [];
  const result = composeDecisionWithSupplements({
    judgment: observation.observed,
    supplements: composedSupplements,
    metadataUrlSchema,
  });
  const shape = classifyObservation({ result, existing });
  if (!storedInputMatchesDecision(inputProvenance, existing)) {
    return RECONCILE_CONTENTION;
  }

  const existingPolicyOutcome = await resolveExistingDecisionPolicy({
    inputProvenance,
    scopedDb,
    existing,
    result,
    shape,
    observedAt,
    observationOrder,
    refresh,
    sourceFingerprintVersion,
    sourceFingerprintFromStoredRaw,
  });
  if (existingPolicyOutcome !== null) {
    return existingPolicyOutcome;
  }

  signal?.throwIfAborted();
  const sourceRawArtifact = await acquireSourceRawArtifact({
    inputProvenance,
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
  if (rawArtifact.s3UploadFailed) {
    // Do not pair newly derived output with a retained older raw object.
    return {
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      inserted: false,
      reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
    };
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
        sourceFingerprintVersion,
        inputProvenance,
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

  const settled = await settleRowWriteStatus({
    scopedDb,
    sourceId,
    decisionId,
    composedSupplements:
      inputProvenance.type === "stored-replay" ? [] : composedSupplements,
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

const processDecisionFromInput = async (
  {
    refresh = DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus = CASE_LAW_CORPUS_DEPENDENCIES,
    judges = CASE_LAW_JUDGE_DEPENDENCIES,
    sourceFingerprintFromStoredRaw:
      readStoredFingerprint = readSourceFingerprintFromStoredRaw,
    ...options
  }: ProcessDecisionOptions & {
    inputProvenance: ProcessDecisionAttemptOptions["inputProvenance"];
  },
  resolveSourceContract: SourceContractResolver = createSourceContractResolver(
    options.scopedDb,
  ),
): Promise<ProcessResult> => {
  const { metadataUrlSchema, sourceFingerprintVersion, statedEcliIdentity } =
    await resolveSourceContract(options.sourceId);
  return await processDecisionAttempt({
    ...options,
    metadataUrlSchema,
    sourceFingerprintVersion,
    sourceFingerprintFromStoredRaw: readStoredFingerprint,
    statedEcliIdentity,
    contentionReconciliation: CONTENTION_RECONCILIATION.INITIAL,
    refresh,
    corpus,
    judges,
  });
};

export const processDecision = async (
  options: ProcessDecisionOptions,
  resolveSourceContract?: SourceContractResolver,
): Promise<ProcessResult> =>
  await processDecisionFromInput(
    {
      ...options,
      inputProvenance: { type: "observation" },
    },
    resolveSourceContract,
  );

type ProcessStoredDecisionOptions = Omit<ProcessDecisionOptions, "refresh"> & {
  sourceRawS3Key: string;
  decisionId: SafeId<"caseLawDecision">;
};

/** Recomposition is a source observation, with its own order and stated description. */
export const processStoredDecision = async (
  { sourceRawS3Key, decisionId, ...options }: ProcessStoredDecisionOptions,
  resolveSourceContract?: SourceContractResolver,
): Promise<ProcessResult> =>
  await processDecisionFromInput(
    {
      ...options,
      refresh: DECISION_REFRESH.ALWAYS,
      inputProvenance: { type: "stored", sourceRawS3Key, decisionId },
    },
    resolveSourceContract,
  );

type ProcessStoredReplayDecisionOptions = Omit<
  ProcessStoredDecisionOptions,
  "observedAt" | "observationOrder"
> & {
  updateToken: string;
};

/** A replay binds the snapshot selected before parsing, without announcing an observation. */
export const processStoredReplayDecision = async (
  {
    sourceRawS3Key,
    decisionId,
    updateToken,
    ...options
  }: ProcessStoredReplayDecisionOptions,
  resolveSourceContract?: SourceContractResolver,
): Promise<ProcessResult> => {
  const stored = await options.scopedDb(async (tx) =>
    (
      await tx
        .select({ observationOrder: caseLawDecisions.sourceObservationOrder })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.id, decisionId),
            eq(caseLawDecisions.sourceId, options.sourceId),
            eq(caseLawDecisions.sourceRawS3Key, sourceRawS3Key),
            sql`${STORED_REPLAY_INPUT_TOKEN} = ${updateToken}`,
            isNull(caseLawDecisions.redactedAt),
          ),
        )
        .limit(1)
    ).at(0),
  );
  if (stored === undefined) {
    return {
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      inserted: false,
      reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
    };
  }
  return await processDecisionFromInput(
    {
      ...options,
      observedAt: new Date(),
      observationOrder: stored.observationOrder ?? 0n,
      refresh: DECISION_REFRESH.ALWAYS,
      inputProvenance: {
        type: "stored-replay",
        sourceRawS3Key,
        decisionId,
        updateToken,
        observationOrder: stored.observationOrder,
      },
    },
    resolveSourceContract,
  );
};
