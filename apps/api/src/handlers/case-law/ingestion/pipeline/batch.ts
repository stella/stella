import { panic, Result } from "better-result";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import type { ScopedDb } from "@/api/db/safe-db-types";
import {
  CITATION_ARRIVAL_DRAIN_OWNER,
  drainCitationArrivalsAfterWrite,
} from "@/api/handlers/case-law/citation-arrivals";
import {
  CASE_LAW_BATCH_FAILURE,
  CaseLawBatchApplyError,
  prepareCaseLawIngestionBatch,
} from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import type {
  AdmittedDecisions,
  BoundedCaseLawIngestionBatch,
  CaseLawBatchFailureReason,
  CaseLawIngestionBatchRecord,
  RejectedCaseLawIngestionRecord,
} from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { planDecisionOrdering } from "@/api/handlers/case-law/ingestion/pipeline/decision-ordering";
import { CASE_LAW_CORPUS_DEPENDENCIES } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import {
  captureFailureEvidence,
  ingestionFailureRecordIdentity,
} from "@/api/handlers/case-law/ingestion/pipeline/failure-evidence";
import {
  type IngestionFailureRow,
  writeIngestionFailureRowsTx,
} from "@/api/handlers/case-law/ingestion/pipeline/failure-evidence-persistence";
import { createGraphTurns } from "@/api/handlers/case-law/ingestion/pipeline/graph-turns";
import { streamKeyedInOrder } from "@/api/handlers/case-law/ingestion/pipeline/keyed-stream";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
  processResultForCorpusOutcome,
  wrappedErrorDetail,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import type { DecisionRefresh } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ConcurrentModificationError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { openCorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";
import type {
  CorpusPackBatch,
  CorpusPackBatchOutcomes,
} from "@/api/lib/legal-search/corpus-pack-batch";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { pgErrorFields } from "@/api/lib/pg-error";

/** How many unsettled records an apply error names. */
const MAX_REPORTED_RECORDS = 20;

/** Column bound of `case_law_ingestion_failures.case_number`. */
const REPORTED_IDENTITY_LENGTH = 256;

const failureRecordsNotWritten = failureSink({
  event: "case_law.ingestion.failure_records_not_written",
  expected: [],
});

/**
 * Grades why a decision was not applied. The failure itself is logged and
 * captured where it is met; the grade separates a record at fault from a
 * database condition that a retry clears.
 */
const decisionNotApplied = failureSink({
  event: "case_law.ingestion.decision_failed",
  expected: [],
});

const sourceLeaseStepFailed = failureSink({
  event: "case_law.ingestion.source_lease_step_failed",
  expected: [],
});

/**
 * Whether a set of failure rows reached the ledger. A timeout or a transient
 * database condition may pass on a replay; a rejection repeats on a replay
 * of the same rows.
 */
export type FailureLedgerWrite =
  | { type: "written" }
  | { type: "unreplayable" }
  | { type: "ownership-unavailable" }
  | { type: "timeout"; error: TimeoutError }
  | { type: "transient"; count: number }
  | { type: "rejected" };

type RecordIngestionFailuresOptions = {
  scopedDb: ScopedDb;
  failures: readonly IngestionFailureRow[];
  adapterKey: string;
};

/** Write a set of failure rows in one insert, and report whether they landed. */
export const recordIngestionFailures = async ({
  scopedDb,
  failures,
  adapterKey,
}: RecordIngestionFailuresOptions): Promise<FailureLedgerWrite> => {
  if (failures.length === 0) {
    return { type: "written" };
  }
  const logged = await Result.tryPromise({
    try: async () =>
      await scopedDb(
        async (tx) => await writeIngestionFailureRowsTx(tx, failures),
      ),
    catch: (cause) => cause,
  });
  if (Result.isOk(logged)) {
    const written = logged.value;
    if (Result.isOk(written)) {
      return written.value;
    }
    const { reason } = written.error;
    switch (reason) {
      case "owner-unavailable":
        return { type: "ownership-unavailable" };
      case "capture":
      case "unaddressable":
        return { type: "unreplayable" };
      default:
        reason satisfies never;
        return panic("Unhandled failure-evidence refusal");
    }
  }
  const { error } = logged;
  observeFailure(error, {
    sink: failureRecordsNotWritten,
    ctx: { adapterKey, step: "recordIngestionFailures" },
  });
  if (error instanceof TimeoutError) {
    return { type: "timeout", error };
  }
  const { grade } = gradeFailure(readEvidence(error), failureRecordsNotWritten);
  return grade === "transient"
    ? { type: "transient", count: failures.length }
    : { type: "rejected" };
};

type ProcessRetryReason =
  (typeof PROCESS_DECISION_RETRY_REASON)[keyof typeof PROCESS_DECISION_RETRY_REASON];

const RETRY_FAILURE = {
  [PROCESS_DECISION_RETRY_REASON.FALLBACK_IDENTITY]:
    CASE_LAW_BATCH_FAILURE.FALLBACK_IDENTITY,
  [PROCESS_DECISION_RETRY_REASON.CONTENTION]: CASE_LAW_BATCH_FAILURE.CONTENTION,
  [PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE]:
    CASE_LAW_BATCH_FAILURE.PACK_WRITE,
  [PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE]:
    CASE_LAW_BATCH_FAILURE.RAW_WRITE,
} as const satisfies Record<ProcessRetryReason, CaseLawBatchFailureReason>;

/** Why a batch stopped before its last record. */
export type DecisionBatchHalt =
  | { type: "retryable"; reason: ProcessRetryReason }
  | { type: "timeout"; error: TimeoutError }
  /**
   * A decision raised a failure that grades transient: the record is not at
   * fault and a retry clears it, so the batch stops and the cursor holds.
   */
  | { type: "transient"; tag: string; message: string }
  | { type: "insert-limit" }
  | { type: "aborted" };

/**
 * Where one reached record ended. `applied` wrote the row and, where it
 * queued payloads, saw them settle; a queued payload alone is not settled.
 */
type RecordSettlement =
  | { type: "applied" }
  | { type: "unchanged" }
  | { type: "unsettled"; reason: CaseLawBatchFailureReason };

type DecisionBatchApplication = {
  /** Rows written, as `processDecision` reports them. */
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  /** Raw and corpus writes that did not land, pack flush included. */
  corpusWriteFailures: number;
  halt: DecisionBatchHalt | null;
  failureLedger: FailureLedgerWrite;
  /** One per reached record, in batch order. */
  settlements: readonly RecordSettlement[];
};

type BatchTally = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  corpusWriteFailures: number;
  settlements: RecordSettlement[];
  failures: IngestionFailureRow[];
  /** The records whose failure rows are in `failures`. */
  ledgerIndexes: number[];
};

type BatchLogContext = {
  adapterKey: string;
  /** The source position the records came from, where there is one. */
  cursor: string | null;
};

/** Fold one decision's outcome into the tally; a retryable one halts. */
const settleDecision = (
  tally: BatchTally,
  outcome: ProcessResult,
): DecisionBatchHalt | null => {
  if (outcome.inserted) {
    tally.inserted++;
  } else {
    tally.skipped++;
  }
  switch (outcome.status) {
    case PROCESS_DECISION_STATUS.COMPLETE:
      if (outcome.searchVectorFailed) {
        tally.searchVectorFailures++;
      }
      tally.settlements.push(
        outcome.inserted ? { type: "applied" } : { type: "unchanged" },
      );
      return null;
    case PROCESS_DECISION_STATUS.RETRYABLE:
      switch (outcome.reason) {
        case PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE:
        case PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE:
          tally.corpusWriteFailures++;
          break;
        case PROCESS_DECISION_RETRY_REASON.CONTENTION:
        case PROCESS_DECISION_RETRY_REASON.FALLBACK_IDENTITY:
          break;
        default:
          outcome.reason satisfies never;
          return panic(`Unhandled reason: ${String(outcome.reason)}`);
      }
      tally.settlements.push({
        type: "unsettled",
        reason: RETRY_FAILURE[outcome.reason],
      });
      return { type: "retryable", reason: outcome.reason };
    default:
      outcome satisfies never;
      return panic(`Unhandled outcome: ${String(outcome)}`);
  }
};

type RejectDecisionOptions = {
  tally: BatchTally;
  error: unknown;
  input: IngestionResult;
  recordIdentity: string | undefined;
  sourceId: SafeId<"caseLawSource">;
  context: BatchLogContext;
  observation: ApplyDecisionBatchOptions["observation"];
};

/**
 * A decision that raised: logged, and recorded for the ledger unless the
 * database timed out, which holds the batch instead. A failure that grades
 * transient (a database condition, a writer of an older release refusing a
 * generation it does not know) is recorded the same way, settles as
 * transient rather than as a rejection of the record, and stops the batch so
 * the cursor holds and the record is read again.
 */
const rejectDecision = ({
  tally,
  error,
  input,
  recordIdentity,
  sourceId,
  context: { adapterKey, cursor },
  observation,
}: RejectDecisionOptions): DecisionBatchHalt | null => {
  const tag = errorTag(error);
  const message = error instanceof Error ? error.message : String(error);

  logger.error(
    "case_law.ingestion.decision_failed",
    sanitizeErrorAttributesForOutput({
      adapterKey,
      caseNumber: input.caseNumber,
      cursor: cursor ?? "",
      ...errorSystemFields(error),
      ...pgErrorFields(error),
      // "message" is stripped by the logger sanitizer; use
      // "error.detail" so the SQL/HTTP/SDK reason reaches
      // CloudWatch. Case-law data is public, no PII concern.
      "error.detail": wrappedErrorDetail(error),
    }),
  );
  captureError(
    error,
    handlerErrorContext("pipeline.rejectDecision", {
      adapterKey,
      caseNumber: input.caseNumber,
      cursor: cursor ?? "",
    }),
  );

  if (error instanceof TimeoutError) {
    tally.settlements.push({
      type: "unsettled",
      reason: CASE_LAW_BATCH_FAILURE.TIMEOUT,
    });
    return { type: "timeout", error };
  }

  tally.ledgerIndexes.push(tally.settlements.length);
  const captured = captureFailureEvidence({
    observation,
    record: { type: "decision", decision: input },
  });
  tally.failures.push({
    sourceId,
    caseNumber: input.caseNumber,
    language: input.language,
    errorType: tag.slice(0, 128),
    errorMessage: message.slice(0, 2048),
    cursor,
    ...ingestionFailureRecordIdentity({
      sourceDocumentId: input.sourceDocumentId,
      recordIdentity,
      replayEvidence: Result.isOk(captured) ? captured.value : undefined,
    }),
    ...(Result.isOk(captured) ? { replayEvidence: captured.value } : {}),
  });
  tally.skipped++;
  const transient =
    gradeFailure(readEvidence(error), decisionNotApplied).grade === "transient";
  tally.settlements.push({
    type: "unsettled",
    reason: transient
      ? CASE_LAW_BATCH_FAILURE.TRANSIENT
      : CASE_LAW_BATCH_FAILURE.RECORD_REJECTED,
  });
  if (transient) {
    // Not a rejection of the record: moving past it would leave it behind a
    // cursor that never returns, so the batch stops here and is read again.
    return { type: "transient", tag, message };
  }

  return null;
};

type RejectSourceRecordOptions = {
  tally: BatchTally;
  record: RejectedCaseLawIngestionRecord;
  sourceId: SafeId<"caseLawSource">;
  observation: ApplyDecisionBatchOptions["observation"];
};

/** Persist a source rejection without reserving a decision identity. */
const rejectSourceRecord = ({
  tally,
  record,
  sourceId,
  observation,
}: RejectSourceRecordOptions): DecisionBatchHalt | null => {
  tally.ledgerIndexes.push(tally.settlements.length);
  const captured = captureFailureEvidence({ record, observation });
  tally.failures.push({
    sourceId,
    caseNumber: record.primaryLabel ?? record.recordKey,
    language: record.language,
    errorType: record.reason,
    errorMessage: record.message,
    cursor: `${record.recordKey}:${record.recordHash}`,
    ...ingestionFailureRecordIdentity({
      sourceDocumentId: undefined,
      recordIdentity: record.recordIdentity ?? record.recordKey,
      replayEvidence: Result.isOk(captured) ? captured.value : undefined,
    }),
    ...(Result.isOk(captured) ? { replayEvidence: captured.value } : {}),
  });
  tally.skipped++;
  tally.settlements.push({
    type: "unsettled",
    reason: CASE_LAW_BATCH_FAILURE.RECORD_REJECTED,
  });
  return null;
};

type SettlePackOptions = {
  tally: BatchTally;
  flushed: Result<CorpusPackBatchOutcomes, unknown>;
  /** The records each decision's queued payloads came from. */
  queued: ReadonlyMap<SafeId<"caseLawDecision">, readonly number[]>;
  context: BatchLogContext;
};

/** A record that wrote its row but whose payloads did not settle. */
const unsettlePayload = (tally: BatchTally, index: number): void => {
  if (tally.settlements[index]?.type === "applied") {
    tally.settlements[index] = {
      type: "unsettled",
      reason: CASE_LAW_BATCH_FAILURE.PACK_WRITE,
    };
  }
};

/**
 * Fold the pack's answer into the records that queued payloads, checking
 * every queued decision rather than only those the pack answered for.
 */
const settlePack = ({
  tally,
  flushed,
  queued,
  context: { adapterKey, cursor },
}: SettlePackOptions): void => {
  if (Result.isError(flushed)) {
    tally.corpusWriteFailures++;
    logger.error(
      "case_law.ingestion.corpus_write_failed",
      sanitizeErrorAttributesForOutput({
        adapterKey,
        cursor: cursor ?? "",
        ...errorSystemFields(flushed.error),
        ...pgErrorFields(flushed.error),
        "error.detail": wrappedErrorDetail(flushed.error),
      }),
    );
    captureError(
      flushed.error,
      handlerErrorContext("pipeline.settlePack.flushed_error", {
        adapterKey,
        step: "applyDecisionBatch.corpusPackFlush",
      }),
    );
    for (const indexes of queued.values()) {
      for (const index of indexes) {
        unsettlePayload(tally, index);
      }
    }
    return;
  }
  for (const [decisionId, indexes] of queued) {
    const outcome = flushed.value.get(decisionId);
    const settlement = processResultForCorpusOutcome(outcome, { decisionId });
    if (settlement.status === PROCESS_DECISION_STATUS.RETRYABLE) {
      tally.corpusWriteFailures++;
      for (const index of indexes) {
        unsettlePayload(tally, index);
      }
      continue;
    }
    if (outcome?.type === "redacted-or-missing") {
      for (const index of indexes) {
        if (tally.settlements[index]?.type === "applied") {
          tally.settlements[index] = { type: "unchanged" };
        }
      }
    }
  }
};

type DecisionBatchObservation = {
  /** The source observation every record of the batch is written under. */
  order: bigint;
  observedAt: Date;
};

/** One record's answer, as the batch folds it in record order. */
type RecordAttempt =
  | { type: "rejected"; record: RejectedCaseLawIngestionRecord }
  | {
      type: "processed";
      input: IngestionResult;
      recordIdentity: string | undefined;
      processed: Result<ProcessResult, unknown>;
      /** The signal had fired by the time the decision returned. */
      aborted: boolean;
    };

type FoldRecordAttemptOptions = {
  tally: BatchTally;
  attempt: RecordAttempt;
  sourceId: SafeId<"caseLawSource">;
  context: BatchLogContext;
  observation: DecisionBatchObservation;
};

/** Fold one record's answer into the tally; a stop is returned. */
const foldRecordAttempt = ({
  tally,
  attempt,
  sourceId,
  context,
  observation,
}: FoldRecordAttemptOptions): DecisionBatchHalt | null => {
  switch (attempt.type) {
    case "rejected":
      return rejectSourceRecord({
        tally,
        record: attempt.record,
        sourceId,
        observation,
      });
    case "processed": {
      if (attempt.aborted) {
        return { type: "aborted" };
      }
      const { processed, input, recordIdentity } = attempt;
      return Result.isError(processed)
        ? rejectDecision({
            tally,
            error: processed.error,
            input,
            recordIdentity,
            sourceId,
            context,
            observation,
          })
        : settleDecision(tally, processed.value);
    }
    default:
      attempt satisfies never;
      return panic(`Unhandled record attempt: ${String(attempt)}`);
  }
};

type ApplyDecisionBatchOptions = {
  batch: AdmittedDecisions;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observation: DecisionBatchObservation;
  refresh: DecisionRefresh;
  corpus: CaseLawCorpusDependencies;
  polarityRules: RuleCache;
  context: BatchLogContext;
  /** Rows this batch may write before it stops, where the caller caps them. */
  insertLimit?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Most decisions written at once; {@link DECISION_BATCH_CONCURRENCY} by default. */
  concurrency?: number | undefined;
};

/**
 * Most decisions of one batch written at once. A decision spends most of its
 * time on object storage and on transactions outside the citation graph
 * lock; the graph transactions still run one at a time, and the batch's
 * decisions take their turn for it in the process (`createGraphTurns`)
 * rather than on a pooled connection.
 */
const DECISION_BATCH_CONCURRENCY = 16;

/**
 * Why a batch left records unstarted: its insert limit, then the signal, in
 * the order the serial batch checked them before each record.
 */
const unstartedStop = ({
  tally,
  insertLimit,
  signal,
}: {
  tally: BatchTally;
  insertLimit: number | undefined;
  signal: AbortSignal | undefined;
}): DecisionBatchHalt => {
  if (insertLimit !== undefined && tally.inserted >= insertLimit) {
    return { type: "insert-limit" };
  }
  if (signal?.aborted === true) {
    return { type: "aborted" };
  }
  return panic("A batch stopped short of its last record unasked");
};

type BatchOrdering = {
  limit: number;
  keysOf: (
    record: CaseLawIngestionBatchRecord,
    index: number,
  ) => readonly string[];
};

const SERIAL_ORDERING: BatchOrdering = { limit: 1, keysOf: () => [] };

type BatchOrderingOptions = {
  records: readonly CaseLawIngestionBatchRecord[];
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  resolveSourceContract: SourceContractResolver;
  concurrency: number;
};

/**
 * How the batch's records may overlap. A source whose records enrich
 * decisions another source holds is written one record at a time: what its
 * records meet is the host's, which nothing the record states keys. So is a
 * batch whose source contract does not resolve (each record then fails on
 * it as the serial batch did), and one whose reach into stored decisions
 * cannot be read or is too wide to split on.
 */
const batchOrdering = async ({
  records,
  sourceId,
  scopedDb,
  resolveSourceContract,
  concurrency,
}: BatchOrderingOptions): Promise<BatchOrdering> => {
  // A record alone has nothing to overlap with, and needs no read to say so.
  if (concurrency <= 1 || records.length <= 1) {
    return SERIAL_ORDERING;
  }
  const contract = await Result.tryPromise({
    try: async () => await resolveSourceContract(sourceId),
    catch: (cause) => cause,
  });
  if (
    Result.isError(contract) ||
    contract.value.heldDecisionAttachment !== null
  ) {
    return SERIAL_ORDERING;
  }
  const planned = await Result.tryPromise({
    try: async () =>
      await planDecisionOrdering({
        records,
        sourceId,
        contract: contract.value,
        scopedDb,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(planned) || planned.value === null) {
    return SERIAL_ORDERING;
  }
  const keys = planned.value;
  return {
    limit: concurrency,
    keysOf: (_record, index) =>
      keys[index] ?? panic("A batch record lost its ordering key"),
  };
};

/**
 * Apply decisions under one observation. Each goes through `processDecision`:
 * decisions that can reach no common row (by identity, docket, ECLI or a
 * stored decision they both name, see `planDecisionOrdering`) are written
 * concurrently, the others in batch order, and every answer is
 * folded in batch order, so the tally, the ledger and where the batch stops
 * read as a serial batch's. Their payloads join one pack flushed once they
 * are processed, and their failures are written to the ledger in one insert.
 *
 * A retryable outcome, a database timeout, a run of rejections, the insert
 * limit or the signal stops the batch: nothing starts after it, what is
 * running finishes, and the pack and the ledger are still written for what
 * it reached. A record past the stop that had already written its row is
 * reported unreached, and applying the batch again finds it unchanged.
 */
export const applyDecisionBatch = async (
  {
    batch: { batchRecords },
    sourceId,
    scopedDb,
    observation,
    refresh,
    corpus,
    polarityRules,
    context,
    insertLimit,
    signal,
    concurrency = DECISION_BATCH_CONCURRENCY,
  }: ApplyDecisionBatchOptions,
  resolveSourceContract: SourceContractResolver = createSourceContractResolver(
    scopedDb,
  ),
): Promise<DecisionBatchApplication> => {
  const tally: BatchTally = {
    inserted: 0,
    skipped: 0,
    searchVectorFailures: 0,
    corpusWriteFailures: 0,
    settlements: [],
    failures: [],
    ledgerIndexes: [],
  };
  const pack = openCorpusPackBatch({
    scopedDb,
    transfer: corpus.transfer,
  });
  // Which record queued each decision's payloads, so every one is checked
  // against the pack's answer rather than only those the pack returned.
  const queued = new Map<SafeId<"caseLawDecision">, number[]>();
  const corpusBatchFor = (index: number): CorpusPackBatch => ({
    enqueue: (entry) => {
      const enqueued = pack.enqueue(entry);
      if (enqueued.isErr()) {
        return enqueued;
      }
      const indexes = queued.get(entry.decisionId);
      if (indexes === undefined) {
        queued.set(entry.decisionId, [index]);
      } else {
        indexes.push(index);
      }
      return enqueued;
    },
    flush: pack.flush,
  });
  const ordering = await batchOrdering({
    records: batchRecords,
    sourceId,
    scopedDb,
    resolveSourceContract,
    concurrency,
  });
  const graphTurn = createGraphTurns();
  // Started records not yet folded may each still insert a row, so the
  // insert limit counts them until their answer is in.
  let started = 0;
  let folded = 0;
  const attempts = streamKeyedInOrder<
    CaseLawIngestionBatchRecord,
    RecordAttempt
  >({
    items: batchRecords,
    limit: ordering.limit,
    keysOf: ordering.keysOf,
    admits: () =>
      signal?.aborted !== true &&
      // Written one at a time, a record starts only once the one before it
      // is folded, so a stop on that one leaves it unstarted, as the serial
      // batch did.
      (ordering.limit > 1 || started === folded) &&
      (insertLimit === undefined ||
        tally.inserted + started - tally.settlements.length < insertLimit),
    operation: async (record, index) => {
      started++;
      if (record.type === "rejected") {
        return { type: "rejected", record };
      }
      const { decision: input, recordIdentity } = record;
      const attempt = await Result.tryPromise({
        try: async () =>
          await processDecision(
            {
              input,
              recordIdentity,
              sourceId,
              scopedDb,
              observedAt: observation.observedAt,
              observationOrder: observation.order,
              refresh,
              corpus,
              corpusBatch: corpusBatchFor(index),
              polarityRules,
              graphTurn,
              citationArrivals: CITATION_ARRIVAL_DRAIN_OWNER.PAGE,
              ...(signal === undefined ? {} : { signal }),
            },
            resolveSourceContract,
          ),
        catch: (cause) => cause,
      });
      return {
        type: "processed",
        input,
        recordIdentity,
        processed: attempt.andThen((outcome) => outcome),
        // A caller cancellation leaves the record for replay. An operation's
        // error without that signal remains a decision failure.
        aborted: signal?.aborted === true,
      };
    },
  });
  let halt: DecisionBatchHalt | null = null;
  let failureLedger: FailureLedgerWrite;
  try {
    for await (const { value: attempt } of attempts) {
      halt = foldRecordAttempt({
        tally,
        attempt,
        sourceId,
        context,
        observation,
      });
      folded++;
      if (halt !== null) {
        break;
      }
    }
    if (halt === null && tally.settlements.length < batchRecords.length) {
      // The stream stopped starting records before the last one.
      halt = unstartedStop({ tally, insertLimit, signal });
    }
  } finally {
    // Drain queued payloads independently of the admission signal.
    // The pack goes out whatever stopped the loop: the decisions already
    // processed have rows waiting for their payloads. One whose settlement
    // did not land holds the caller's progress, so the batch is applied
    // again and it joins that batch's pack.
    //
    // A flush that fails outright is the whole batch's corpus write
    // failing, counted as such: raising from a `finally` would replace
    // whatever stopped the loop and skip the failure rows below.
    settlePack({ tally, flushed: await pack.flush(), queued, context });
    // The citations the page's decisions answer, reopened and settled once
    // for the page rather than once per decision. The arrivals committed with
    // their rows, so a drain that fails leaves them for the next one.
    await drainCitationArrivalsAfterWrite(scopedDb, {
      step: "pipeline.applyDecisionBatch.citation_arrivals",
      attributes: { adapterKey: context.adapterKey },
    });
    // Written unconditionally, so a halted batch still records the failures
    // it most needs recorded.
    failureLedger = await recordIngestionFailures({
      scopedDb,
      failures: tally.failures,
      adapterKey: context.adapterKey,
    });
  }
  if (failureLedger.type !== "written") {
    // A rejection settles only once its replay input is certified.
    for (const index of tally.ledgerIndexes) {
      const settlement =
        tally.settlements.at(index) ??
        panic("Failure ledger index has no settlement");
      // The original transient failure remains the retry cause for an unbacked reservation.
      if (
        failureLedger.type !== "ownership-unavailable" ||
        settlement.type !== "unsettled" ||
        settlement.reason !== CASE_LAW_BATCH_FAILURE.TRANSIENT
      ) {
        tally.settlements[index] = {
          type: "unsettled",
          reason: CASE_LAW_BATCH_FAILURE.FAILURE_WRITE,
        };
      }
    }
  }
  return {
    inserted: tally.inserted,
    skipped: tally.skipped,
    searchVectorFailures: tally.searchVectorFailures,
    corpusWriteFailures: tally.corpusWriteFailures,
    halt,
    failureLedger,
    settlements: tally.settlements,
  };
};

const uncertifiedBatch = (
  reason: CaseLawBatchFailureReason,
  records: readonly CaseLawIngestionBatchRecord[],
  message: string,
): CaseLawBatchApplyError =>
  new CaseLawBatchApplyError({
    message,
    reason,
    unsettled: records.length,
    records: [],
  });

/**
 * Run one step that renews or relies on the source lease. A lost lease and
 * a database timeout are the batch's answer; any other fault is observed and
 * holds the batch, retryable only when it grades as transient.
 */
const underSourceLease = async <T>(
  records: readonly CaseLawIngestionBatchRecord[],
  step: () => Promise<T>,
): Promise<Result<T, CaseLawBatchApplyError>> => {
  const done = await Result.tryPromise({ try: step, catch: (cause) => cause });
  if (Result.isOk(done)) {
    return Result.ok(done.value);
  }
  const { error } = done;
  if (error instanceof ConcurrentModificationError) {
    return Result.err(
      uncertifiedBatch(
        CASE_LAW_BATCH_FAILURE.LEASE_LOST,
        records,
        error.message,
      ),
    );
  }
  if (error instanceof TimeoutError) {
    return Result.err(
      uncertifiedBatch(CASE_LAW_BATCH_FAILURE.TIMEOUT, records, error.message),
    );
  }
  observeFailure(error, {
    sink: sourceLeaseStepFailed,
    ctx: { step: "underSourceLease" },
  });
  return Result.err(
    uncertifiedBatch(
      gradeFailure(readEvidence(error), sourceLeaseStepFailed).grade ===
        "transient"
        ? CASE_LAW_BATCH_FAILURE.TRANSIENT
        : CASE_LAW_BATCH_FAILURE.UNCLASSIFIED,
      records,
      error instanceof Error ? error.message : String(error),
    ),
  );
};

/** A stop that no reached record's own settlement accounts for. */
const stopFailure = (
  stop: DecisionBatchHalt | null,
): CaseLawBatchFailureReason | null => {
  if (stop === null) {
    return null;
  }
  switch (stop.type) {
    case "retryable":
    case "timeout":
    case "transient":
      // The record that stopped the batch carries the reason.
      return null;
    case "aborted":
      return CASE_LAW_BATCH_FAILURE.ABORTED;
    case "insert-limit":
      return panic("A prepared batch carries no insert limit");
    default:
      stop satisfies never;
      return panic(`Unhandled batch stop: ${String(stop)}`);
  }
};

type UnsettledRecord = { index: number; reason: CaseLawBatchFailureReason };

/**
 * Why an applied batch cannot be certified, or null once every record has
 * settled. An unwritten ledger comes first, then what stopped the batch,
 * then any reason a retry can clear; a rejection the ledger holds is named
 * only when it is all that is wrong.
 */
const batchFailure = (
  records: readonly CaseLawIngestionBatchRecord[],
  { halt, settlements }: DecisionBatchApplication,
): CaseLawBatchApplyError | null => {
  const unsettled: UnsettledRecord[] = settlements.flatMap(
    (settlement, index) =>
      settlement.type === "unsettled"
        ? [{ index, reason: settlement.reason }]
        : [],
  );
  const reasonWhere = (
    matches: (reason: CaseLawBatchFailureReason) => boolean,
  ): CaseLawBatchFailureReason | null =>
    unsettled.find(({ reason }) => matches(reason))?.reason ?? null;
  const reason =
    reasonWhere((found) => found === CASE_LAW_BATCH_FAILURE.FAILURE_WRITE) ??
    stopFailure(halt) ??
    reasonWhere((found) => found !== CASE_LAW_BATCH_FAILURE.RECORD_REJECTED) ??
    unsettled.at(0)?.reason ??
    null;
  const settled = settlements.length - unsettled.length;
  if (reason === null) {
    return settled === records.length
      ? null
      : panic("A batch that did not stop left a record unreached");
  }
  const count = records.length - settled;
  return new CaseLawBatchApplyError({
    message: `${count} of ${records.length} record(s) not settled (${reason})`,
    reason,
    unsettled: count,
    records: unsettled.slice(0, MAX_REPORTED_RECORDS).map((record) => {
      const input =
        records.at(record.index) ?? panic("Settlement without its record");
      return {
        index: record.index,
        reason: record.reason,
        caseNumber: (input.type === "decision"
          ? input.decision.caseNumber
          : (input.primaryLabel ?? input.recordKey)
        ).slice(0, REPORTED_IDENTITY_LENGTH),
        sourceDocumentId:
          input.type === "decision"
            ? (input.decision.sourceDocumentId?.slice(
                0,
                REPORTED_IDENTITY_LENGTH,
              ) ?? null)
            : null,
      };
    }),
  });
};

type ApplyCaseLawIngestionBatchOptions = {
  batch: BoundedCaseLawIngestionBatch;
  sourceLease: CaseLawSourceIngestionLease;
  scopedDb: ScopedDb;
  signal: AbortSignal;
  refresh: DecisionRefresh;
  corpus?: CaseLawCorpusDependencies;
};

type CaseLawBatchReceipt = {
  status: "settled";
  observationOrder: bigint;
  observedAt: Date;
  /** Records whose row this batch wrote, updates included. */
  applied: number;
  unchanged: number;
};

/**
 * Apply a prepared batch through the path a crawl page takes, and certify it
 * only once every record has settled: its row written or left unchanged, or
 * its exact input durably parked for review, and any queued payload settled
 * in the pack. Anything short of that is an
 * error naming why; applying the same batch again converges.
 *
 * Order: an owned copy of the records admitted again, lease renewal, one
 * source observation for the batch, the records, the pack and the failure
 * ledger, then a last lease renewal before the receipt.
 */
export const applyCaseLawIngestionBatch = async ({
  batch,
  sourceLease,
  scopedDb,
  signal,
  refresh,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
}: ApplyCaseLawIngestionBatchOptions): Promise<
  Result<CaseLawBatchReceipt, CaseLawBatchApplyError>
> => {
  const { source } = sourceLease;
  if (signal.aborted) {
    return Result.err(
      uncertifiedBatch(
        CASE_LAW_BATCH_FAILURE.ABORTED,
        batch.batchRecords,
        "Batch aborted before it was ordered",
      ),
    );
  }
  // Re-admit before cloning: a caller may have mutated a rejected DTO since
  // preparation, and an Error must never cross structuredClone as a record.
  const current = prepareCaseLawIngestionBatch({ records: batch.batchRecords });
  if (Result.isError(current)) {
    return Result.err(
      uncertifiedBatch(
        CASE_LAW_BATCH_FAILURE.OUT_OF_BOUNDS,
        batch.batchRecords,
        current.error.message,
      ),
    );
  }
  const owned = prepareCaseLawIngestionBatch({
    records: structuredClone(current.value.batchRecords),
  });
  if (Result.isError(owned)) {
    return Result.err(
      uncertifiedBatch(
        CASE_LAW_BATCH_FAILURE.OUT_OF_BOUNDS,
        batch.batchRecords,
        owned.error.message,
      ),
    );
  }
  const { batchRecords } = owned.value;
  // Ordered once the records exist and before any write, as a crawl orders
  // a page after its response: the row guards compare this order.
  const ordered = await underSourceLease(batchRecords, async () => {
    await sourceLease.beforeDatabaseMark();
    return await allocateSourceObservationOrder({
      leaseToken: sourceLease.leaseToken,
      scopedDb,
      sourceId: source.id,
    });
  });
  if (Result.isError(ordered)) {
    return Result.err(ordered.error);
  }
  const observation = { order: ordered.value, observedAt: new Date() };
  const application = await applyDecisionBatch({
    batch: owned.value,
    sourceId: source.id,
    scopedDb,
    observation,
    refresh,
    corpus,
    polarityRules: new Map(),
    context: { adapterKey: source.adapterKey, cursor: null },
    signal,
  });
  const failure = batchFailure(batchRecords, application);
  if (
    failure !== null &&
    failure.reason !== CASE_LAW_BATCH_FAILURE.RECORD_REJECTED
  ) {
    return Result.err(failure);
  }
  const held = await underSourceLease(
    batchRecords,
    sourceLease.beforeDatabaseMark,
  );
  if (Result.isError(held)) {
    return Result.err(held.error);
  }
  if (failure !== null) {
    return Result.err(failure);
  }
  const applied = application.settlements.filter(
    ({ type }) => type === "applied",
  ).length;
  return Result.ok({
    status: "settled",
    observationOrder: observation.order,
    observedAt: observation.observedAt,
    applied,
    unchanged: batchRecords.length - applied,
  });
};
