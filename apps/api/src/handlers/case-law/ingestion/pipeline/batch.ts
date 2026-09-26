import { Result, panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawIngestionFailures } from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  CASE_LAW_BATCH_FAILURE,
  CaseLawBatchApplyError,
  prepareCaseLawIngestionBatch,
} from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import type {
  AdmittedDecisions,
  BoundedCaseLawIngestionBatch,
  CaseLawBatchFailureReason,
} from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { CASE_LAW_CORPUS_DEPENDENCIES } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
  processResultForCorpusOutcome,
  wrappedErrorDetail,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
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
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { pgErrorFields } from "@/api/lib/pg-error";

/**
 * Consecutive rejected decisions after which a batch stops: past this many,
 * the source is more likely broken than any one record.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

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

export type IngestionFailureRow = typeof caseLawIngestionFailures.$inferInsert;

/** Column bounds of `case_law_ingestion_failures` (schema/case-law.ts). */
const INGESTION_FAILURE_LIMITS = {
  caseNumber: 256,
  language: 8,
  errorType: 128,
  errorMessage: 2048,
} as const;

/** Postgres text and jsonb columns do not store NUL characters. */
const storableText = (value: string, maxLength?: number): string => {
  const text = value.replaceAll("\u0000", "");
  return maxLength === undefined ? text : text.slice(0, maxLength);
};

/**
 * A failure row as the table accepts it: values copied from the decision
 * that failed are held to the column bounds and carry no NUL characters.
 */
const storableIngestionFailure = (
  row: IngestionFailureRow,
): IngestionFailureRow => ({
  ...row,
  caseNumber: storableText(row.caseNumber, INGESTION_FAILURE_LIMITS.caseNumber),
  errorType: storableText(row.errorType, INGESTION_FAILURE_LIMITS.errorType),
  errorMessage: storableText(
    row.errorMessage,
    INGESTION_FAILURE_LIMITS.errorMessage,
  ),
  ...(typeof row.language === "string"
    ? {
        language: storableText(row.language, INGESTION_FAILURE_LIMITS.language),
      }
    : {}),
  ...(typeof row.cursor === "string"
    ? { cursor: storableText(row.cursor) }
    : {}),
});

const logIngestionFailures = async (
  scopedDb: ScopedDb,
  failures: readonly IngestionFailureRow[],
) => {
  if (failures.length === 0) {
    return;
  }
  // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
  // oxlint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
    return tx
      .insert(caseLawIngestionFailures)
      .values(failures.map(storableIngestionFailure));
  });
};

/**
 * Whether a set of failure rows reached the ledger. A timeout or a transient
 * database condition may pass on a replay; a rejection repeats on a replay
 * of the same rows.
 */
export type FailureLedgerWrite =
  | { type: "written" }
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
  const logged = await Result.tryPromise({
    try: async () => await logIngestionFailures(scopedDb, failures),
    catch: (cause) => cause,
  });
  if (Result.isOk(logged)) {
    return { type: "written" };
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
  | { type: "insert-limit" }
  | { type: "failure-streak"; tag: string; message: string }
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
  /** Consecutive rejected decisions at the batch's end. */
  failureStreak: number;
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
  failureStreak: number;
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
  tally.failureStreak = 0;
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
  sourceId: SafeId<"caseLawSource">;
  context: BatchLogContext;
};

/**
 * A decision that raised: logged, and recorded for the ledger unless the
 * database timed out, which holds the batch instead. A transient database
 * condition is recorded the same way, and settles as transient rather than
 * as a rejection of the record.
 */
const rejectDecision = ({
  tally,
  error,
  input,
  sourceId,
  context: { adapterKey, cursor },
}: RejectDecisionOptions): DecisionBatchHalt | null => {
  tally.failureStreak++;
  const tag = errorTag(error);
  const message = error instanceof Error ? error.message : String(error);

  logger.error("case_law.ingestion.decision_failed", {
    adapterKey,
    caseNumber: input.caseNumber,
    cursor: cursor ?? "",
    ...errorSystemFields(error),
    ...pgErrorFields(error),
    // "message" is stripped by the logger sanitizer; use
    // "error.detail" so the SQL/HTTP/SDK reason reaches
    // CloudWatch. Case-law data is public, no PII concern.
    "error.detail": wrappedErrorDetail(error),
    consecutiveFailures: tally.failureStreak,
  });
  captureError(error, {
    adapterKey,
    caseNumber: input.caseNumber,
    cursor: cursor ?? "",
  });

  if (error instanceof TimeoutError) {
    tally.settlements.push({
      type: "unsettled",
      reason: CASE_LAW_BATCH_FAILURE.TIMEOUT,
    });
    return { type: "timeout", error };
  }

  tally.ledgerIndexes.push(tally.settlements.length);
  tally.failures.push({
    sourceId,
    caseNumber: input.caseNumber,
    language: input.language,
    errorType: tag.slice(0, 128),
    errorMessage: message.slice(0, 2048),
    cursor,
  });
  tally.skipped++;
  tally.settlements.push({
    type: "unsettled",
    reason:
      gradeFailure(readEvidence(error), decisionNotApplied).grade ===
      "transient"
        ? CASE_LAW_BATCH_FAILURE.TRANSIENT
        : CASE_LAW_BATCH_FAILURE.RECORD_REJECTED,
  });

  return tally.failureStreak >= MAX_CONSECUTIVE_FAILURES
    ? { type: "failure-streak", tag, message }
    : null;
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
    logger.error("case_law.ingestion.corpus_write_failed", {
      adapterKey,
      cursor: cursor ?? "",
      ...errorSystemFields(flushed.error),
      ...pgErrorFields(flushed.error),
      "error.detail": wrappedErrorDetail(flushed.error),
    });
    captureError(flushed.error, {
      adapterKey,
      step: "applyDecisionBatch.corpusPackFlush",
    });
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

type ApplyDecisionBatchOptions = {
  batch: AdmittedDecisions;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observation: DecisionBatchObservation;
  refresh: DecisionRefresh;
  corpus: CaseLawCorpusDependencies;
  polarityRules: RuleCache;
  context: BatchLogContext;
  /** Consecutive rejected decisions carried in from earlier batches. */
  failureStreak: number;
  /** Rows this batch may write before it stops, where the caller caps them. */
  insertLimit?: number | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * Apply decisions under one observation: each goes through `processDecision`
 * in order, their payloads join one pack flushed once they are processed,
 * and their failures are written to the ledger in one insert. A retryable
 * outcome, a database timeout, a run of rejections, the insert limit or the
 * signal stops the batch; the pack and the ledger are still written for
 * what it reached.
 */
export const applyDecisionBatch = async ({
  batch: { decisions },
  sourceId,
  scopedDb,
  observation,
  refresh,
  corpus,
  polarityRules,
  context,
  failureStreak,
  insertLimit,
  signal,
}: ApplyDecisionBatchOptions): Promise<DecisionBatchApplication> => {
  const tally: BatchTally = {
    inserted: 0,
    skipped: 0,
    searchVectorFailures: 0,
    corpusWriteFailures: 0,
    failureStreak,
    settlements: [],
    failures: [],
    ledgerIndexes: [],
  };
  const pack = openCorpusPackBatch({
    scopedDb,
    transfer: corpus.transfer,
    ...(signal === undefined ? {} : { signal }),
  });
  // Which record queued each decision's payloads, so every one is checked
  // against the pack's answer rather than only those the pack returned.
  const queued = new Map<SafeId<"caseLawDecision">, number[]>();
  let current = 0;
  const corpusBatch: CorpusPackBatch = {
    enqueue: (entry) => {
      const indexes = queued.get(entry.decisionId);
      if (indexes === undefined) {
        queued.set(entry.decisionId, [current]);
      } else {
        indexes.push(current);
      }
      pack.enqueue(entry);
    },
    flush: pack.flush,
  };
  let halt: DecisionBatchHalt | null = null;
  let failureLedger: FailureLedgerWrite;
  try {
    for (const [index, input] of decisions.entries()) {
      if (insertLimit !== undefined && tally.inserted >= insertLimit) {
        halt = { type: "insert-limit" };
        break;
      }
      if (signal?.aborted) {
        halt = { type: "aborted" };
        break;
      }
      current = index;
      const processed = await Result.tryPromise({
        try: async () =>
          // db-await-in-loop: per-decision ingest pipeline: identity locks, corpus write, upsert, citations, ordered per observation
          await processDecision({
            input,
            sourceId,
            scopedDb,
            observedAt: observation.observedAt,
            observationOrder: observation.order,
            refresh,
            corpus,
            corpusBatch,
            polarityRules,
          }),
        catch: (cause) => cause,
      });
      halt = Result.isError(processed)
        ? rejectDecision({
            tally,
            error: processed.error,
            input,
            sourceId,
            context,
          })
        : settleDecision(tally, processed.value);
      if (halt !== null) {
        break;
      }
    }
  } finally {
    // The pack goes out whatever stopped the loop: the decisions already
    // processed have rows waiting for their payloads. One whose settlement
    // did not land holds the caller's progress, so the batch is applied
    // again and it joins that batch's pack.
    //
    // A flush that fails outright is the whole batch's corpus write
    // failing, counted as such: raising from a `finally` would replace
    // whatever stopped the loop and skip the failure rows below.
    settlePack({ tally, flushed: await corpusBatch.flush(), queued, context });
    // Written unconditionally, so a halted batch still records the failures
    // it most needs recorded.
    failureLedger = await recordIngestionFailures({
      scopedDb,
      failures: tally.failures,
      adapterKey: context.adapterKey,
    });
  }
  if (failureLedger.type !== "written") {
    // Not recorded, so not a settled rejection either.
    for (const index of tally.ledgerIndexes) {
      tally.settlements[index] = {
        type: "unsettled",
        reason: CASE_LAW_BATCH_FAILURE.FAILURE_WRITE,
      };
    }
  }
  return {
    inserted: tally.inserted,
    skipped: tally.skipped,
    searchVectorFailures: tally.searchVectorFailures,
    corpusWriteFailures: tally.corpusWriteFailures,
    failureStreak: tally.failureStreak,
    halt,
    failureLedger,
    settlements: tally.settlements,
  };
};

const uncertifiedBatch = (
  reason: CaseLawBatchFailureReason,
  decisions: readonly IngestionResult[],
  message: string,
): CaseLawBatchApplyError =>
  new CaseLawBatchApplyError({
    message,
    reason,
    unsettled: decisions.length,
    records: [],
  });

/**
 * Run one step that renews or relies on the source lease. A lost lease and
 * a database timeout are the batch's answer; any other fault is not one
 * this boundary classifies, and propagates as it does from a crawl.
 */
const underSourceLease = async <T>(
  decisions: readonly IngestionResult[],
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
        decisions,
        error.message,
      ),
    );
  }
  if (error instanceof TimeoutError) {
    return Result.err(
      uncertifiedBatch(
        CASE_LAW_BATCH_FAILURE.TIMEOUT,
        decisions,
        error.message,
      ),
    );
  }
  throw error;
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
    case "failure-streak":
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
  decisions: readonly IngestionResult[],
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
    return settled === decisions.length
      ? null
      : panic("A batch that did not stop left a record unreached");
  }
  const count = decisions.length - settled;
  return new CaseLawBatchApplyError({
    message: `${count} of ${decisions.length} record(s) not settled (${reason})`,
    reason,
    unsettled: count,
    records: unsettled.slice(0, MAX_REPORTED_RECORDS).map((record) => {
      const decision =
        decisions.at(record.index) ?? panic("Settlement without its record");
      return {
        index: record.index,
        reason: record.reason,
        caseNumber: decision.caseNumber.slice(0, REPORTED_IDENTITY_LENGTH),
        sourceDocumentId:
          decision.sourceDocumentId?.slice(0, REPORTED_IDENTITY_LENGTH) ?? null,
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
 * only once every record has settled: its row written or left unchanged, and
 * any payload it queued settled in the pack. Anything short of that is an
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
        batch.decisions,
        "Batch aborted before it was ordered",
      ),
    );
  }
  // An owned copy, admitted again: the prepared batch holds the caller's
  // records, which may have changed since they were measured.
  const owned = prepareCaseLawIngestionBatch({
    decisions: structuredClone(batch.decisions),
  });
  if (Result.isError(owned)) {
    return Result.err(
      uncertifiedBatch(
        CASE_LAW_BATCH_FAILURE.OUT_OF_BOUNDS,
        batch.decisions,
        owned.error.message,
      ),
    );
  }
  const { decisions } = owned.value;
  // Ordered once the records exist and before any write, as a crawl orders
  // a page after its response: the row guards compare this order.
  const ordered = await underSourceLease(decisions, async () => {
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
    failureStreak: 0,
    signal,
  });
  const failure = batchFailure(decisions, application);
  if (failure !== null) {
    return Result.err(failure);
  }
  const held = await underSourceLease(
    decisions,
    sourceLease.beforeDatabaseMark,
  );
  if (Result.isError(held)) {
    return Result.err(held.error);
  }
  const applied = application.settlements.filter(
    ({ type }) => type === "applied",
  ).length;
  return Result.ok({
    status: "settled",
    observationOrder: observation.order,
    observedAt: observation.observedAt,
    applied,
    unchanged: decisions.length - applied,
  });
};
