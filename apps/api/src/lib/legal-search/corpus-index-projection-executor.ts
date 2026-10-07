import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { Buffer } from "node:buffer";

import { streamWithConcurrency } from "@stll/concurrency";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { corpusIndexProjectionStates } from "@/api/db/schema";
import { PayloadBudgetError } from "@/api/lib/compression";
import { settleBoth } from "@/api/lib/corpus-index/core";
import { errorFingerprint } from "@/api/lib/errors/utils";
import {
  type CorpusIndexClient,
  type CorpusIndexError,
  isCorpusIndexRequestTimeout,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  buildCorpusProjectionDocuments,
  legislationV2NeedsPassages,
} from "@/api/lib/legal-search/corpus-index-projection-builder";
import {
  CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
  CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS,
  planCorpusProjectionAppendRequests,
  type CorpusProjectionAppendEntry,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  readReservedCorpusProjectionMaterialsTx,
  type CorpusProjectionMaterial,
} from "@/api/lib/legal-search/corpus-index-projection-materials";
import type { CorpusProjectionAppendScopedWorkSelection } from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  abandonCorpusProjectionAppendTx,
  acceptCorpusProjectionAppendTx,
  cancelCorpusProjectionReservationTx,
  classifyCorpusProjectionReservationFailureTx,
  CORPUS_PROJECTION_RETRY_MAX_MS,
  CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX,
  CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN,
  CORPUS_PROJECTION_RETRY_MIN_MS,
  CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
  prepareCorpusProjectionReplacementsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendBatchTx,
  type CorpusProjectionAppendAbandonResult,
  startCorpusProjectionMultipartAppendTx,
  continueCorpusProjectionAppendPartTx,
  type CorpusProjectionReservationFailure,
  type CorpusProjectionIntentLease,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-reads";
import { readCorpusAtAuthoritativePointer } from "@/api/lib/legal-search/corpus-storage";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { S3ObjectBudgetError } from "@/api/lib/s3";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;
/**
 * Appends return on acceptance (`commit=auto`). Publication is confirmed by
 * `confirmCorpusProjectionAppends`, which does not hold the append lease, so
 * a node that publishes slowly delays convergence instead of failing it.
 */
type ProjectionAppendClient = Pick<CorpusIndexClient, "ingestQueuedBatch">;

const measured = async <Value>(
  operation: () => Promise<Value>,
  record: (elapsedMs: number) => void,
): Promise<Value> => {
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  const value = await operation();
  record(Temporal.Now.instant().epochMilliseconds - startedAt);
  return value;
};

const mapSequentially = async <Input, Output>(
  values: readonly Input[],
  operation: (value: Input) => Promise<Output>,
  index = 0,
  outputs: Output[] = [],
): Promise<Output[]> => {
  const value = values.at(index);
  if (value === undefined) {
    return outputs;
  }
  outputs.push(await operation(value));
  return mapSequentially(values, operation, index + 1, outputs);
};

export const CORPUS_PROJECTION_PAYLOAD_READ_CONCURRENCY_MAX = 32;

type ExecuteCorpusProjectionAppendCycleOptions<
  Family extends CorpusProjectionIntentLease["family"],
> = CorpusProjectionAppendScopedWorkSelection<Family> & {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  generation: string;
  limit: number;
  leaseMs: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
  payloadReader?: typeof loadCorpusProjectionPayload;
};

/** Wall-clock milliseconds per phase, summed over the cycle, for the caller's logs. */
export type CorpusProjectionAppendCycleTiming = {
  reservationMs: number;
  materialReadMs: number;
  /**
   * How long the cycle waited on the payload pool: the time between asking
   * for the next revision and having it, summed over the revisions.
   *
   * This is stall, not work. Reads and builds run inside a pool that keeps
   * refilling while the cycle appends, so a pool that keeps up reports close
   * to zero however much I/O it did, and a rising number means the reads
   * cannot feed the appends.
   */
  payloadLoadMs: number;
  /**
   * Parsing a payload into documents and serializing them, summed over the
   * revisions.
   *
   * Measured apart from `payloadLoadMs` because the two answer opposite
   * questions. This is synchronous work on one thread, so it adds up to real
   * elapsed time and a cycle spending most of it here is CPU-bound, not
   * I/O-bound. Without the split the phase reads as object-storage latency
   * however it is actually spent.
   */
  documentBuildMs: number;
  ingestMs: number;
  storeCommitMs: number;
};

export type CorpusProjectionAppendCycleResult = {
  status:
    | "idle"
    | "completed"
    | "append_unknown"
    | "append_blocked"
    | "engine_unavailable";
  cycleRetryDelayMs: number | null;
  replacementCleanupScheduled: number;
  reserved: number;
  /** Revisions the engine accepted (or may have); a census confirms them. */
  accepted: number;
  staleCleanupPending: number;
  unknownCleanupPending: number;
  cancelled: number;
  leaseLost: number;
  unread: number;
  retryScheduled: number;
  blocked: number;
  requestCount: number;
  timing: CorpusProjectionAppendCycleTiming;
};

const emptyResult = (
  replacementCleanupScheduled: number,
  timing: CorpusProjectionAppendCycleTiming,
): CorpusProjectionAppendCycleResult => ({
  status: "idle",
  cycleRetryDelayMs: null,
  replacementCleanupScheduled,
  timing,
  reserved: 0,
  accepted: 0,
  staleCleanupPending: 0,
  unknownCleanupPending: 0,
  cancelled: 0,
  leaseLost: 0,
  unread: 0,
  retryScheduled: 0,
  blocked: 0,
  requestCount: 0,
});

const validateExecutorPolicy = (
  payloadReadConcurrency: number,
  retryDelayMs: number,
  payloadRetryLimit: number,
): void => {
  if (
    !Number.isSafeInteger(payloadReadConcurrency) ||
    payloadReadConcurrency < 1 ||
    payloadReadConcurrency > CORPUS_PROJECTION_PAYLOAD_READ_CONCURRENCY_MAX
  ) {
    return panic(
      `Corpus projection payload read concurrency must be an integer from 1 to ${CORPUS_PROJECTION_PAYLOAD_READ_CONCURRENCY_MAX}`,
    );
  }
  if (
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < CORPUS_PROJECTION_RETRY_MIN_MS ||
    retryDelayMs > CORPUS_PROJECTION_RETRY_MAX_MS
  ) {
    return panic(
      `Corpus projection retry delay must be an integer from ${CORPUS_PROJECTION_RETRY_MIN_MS} to ${CORPUS_PROJECTION_RETRY_MAX_MS} milliseconds`,
    );
  }
  if (
    !Number.isSafeInteger(payloadRetryLimit) ||
    payloadRetryLimit < CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN ||
    payloadRetryLimit > CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX
  ) {
    return panic(
      `Corpus projection payload retry limit must be an integer from ${CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN} to ${CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX}`,
    );
  }
};

const cancelReservations = async ({
  runInTransaction,
  leases,
  errorMessage,
}: {
  runInTransaction: ProjectionTransactionRunner;
  leases: readonly CorpusProjectionIntentLease[];
  errorMessage: string;
}): Promise<{ cancelled: number; leaseLost: number }> => {
  if (leases.length === 0) {
    return { cancelled: 0, leaseLost: 0 };
  }
  return await runInTransaction(async (tx) => {
    const outcomes = await mapSequentially(leases, async (lease) =>
      cancelCorpusProjectionReservationTx(tx, {
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        errorMessage,
      }),
    );
    return {
      cancelled: outcomes.filter((outcome) => outcome === "cancelled").length,
      leaseLost: outcomes.filter((outcome) => outcome === "lease_lost").length,
    };
  });
};

type ReservationFailure = {
  lease: CorpusProjectionIntentLease;
  failure: CorpusProjectionReservationFailure;
};

const classifyReservationFailures = async ({
  runInTransaction,
  failures,
}: {
  runInTransaction: ProjectionTransactionRunner;
  failures: readonly ReservationFailure[];
}): Promise<{
  retryScheduled: number;
  blocked: number;
  staleCancelled: number;
  leaseLost: number;
}> => {
  if (failures.length === 0) {
    return {
      retryScheduled: 0,
      blocked: 0,
      staleCancelled: 0,
      leaseLost: 0,
    };
  }
  const classified = await runInTransaction(async (tx) => {
    const outcomes = await mapSequentially(failures, async (failure) =>
      classifyCorpusProjectionReservationFailureTx(tx, {
        intentId: failure.lease.intentId,
        leaseToken: failure.lease.leaseToken,
        failure: failure.failure,
      }),
    );
    const blockedLeases = failures.flatMap((failure, index) =>
      outcomes.at(index) === "blocked" ? [failure.lease] : [],
    );
    const firstBlockedLease = blockedLeases.at(0);
    const blockedStates =
      firstBlockedLease === undefined
        ? []
        : await tx
            .select({
              entityId: corpusIndexProjectionStates.entityId,
              failureAttempts: corpusIndexProjectionStates.failureAttempts,
              lastFailureKind: corpusIndexProjectionStates.lastFailureKind,
            })
            .from(corpusIndexProjectionStates)
            .where(
              and(
                eq(
                  corpusIndexProjectionStates.family,
                  firstBlockedLease.family,
                ),
                eq(
                  corpusIndexProjectionStates.generation,
                  firstBlockedLease.generation,
                ),
                inArray(
                  corpusIndexProjectionStates.entityId,
                  blockedLeases.map(({ entityId }) => entityId),
                ),
              ),
            );
    return {
      retryScheduled: outcomes.filter(
        (outcome) => outcome === "retry_scheduled",
      ).length,
      blocked: outcomes.filter((outcome) => outcome === "blocked").length,
      staleCancelled: outcomes.filter(
        (outcome) => outcome === "stale_cancelled",
      ).length,
      leaseLost: outcomes.filter((outcome) => outcome === "lease_lost").length,
      blockedStates,
    };
  });
  for (const state of classified.blockedStates) {
    logger.warn("corpus_projection.append_blocked", {
      entity: state.entityId,
      kind:
        state.lastFailureKind ??
        panic(`Blocked projection has no failure kind: ${state.entityId}`),
      attempts: state.failureAttempts,
    });
  }
  return classified;
};

const rereadMaterial = async (
  runInTransaction: ProjectionTransactionRunner,
  lease: CorpusProjectionIntentLease,
): Promise<CorpusProjectionMaterial | null> => {
  const current = await runInTransaction(
    async (tx) =>
      await readReservedCorpusProjectionMaterialsTx(tx, { leases: [lease] }),
  );
  return current.ready.at(0) ?? null;
};

const loadCorpusProjectionPayload = async (
  runInTransaction: ProjectionTransactionRunner,
  material: CorpusProjectionMaterial,
) => {
  let currentPromise: Promise<CorpusProjectionMaterial | null> | undefined;
  const current = async () => {
    currentPromise ??= rereadMaterial(runInTransaction, material.lease);
    return await currentPromise;
  };
  const textPromise = readCorpusAtAuthoritativePointer({
    storedKey: material.textS3Key,
    read: readCorpusText,
    rereadStoredKey: async () => (await current())?.textS3Key ?? null,
  });
  if (material.astS3Key === null) {
    return { text: await textPromise, ast: null };
  }
  const storedAstPointer = material.astS3Key;
  const loadAst = async () =>
    await readCorpusAtAuthoritativePointer({
      storedKey: storedAstPointer,
      read: readCorpusAst,
      rereadStoredKey: async () => {
        const replacement = await current();
        return replacement?.astS3Key ?? null;
      },
    });
  if (material.family === "case_law") {
    const [text, ast] = await settleBoth(textPromise, loadAst());
    return { text, ast };
  }
  const text = await textPromise;
  if (
    !legislationV2NeedsPassages({
      input: material.input,
      text,
      revision: material.lease.intentId,
    })
  ) {
    return { text, ast: null };
  }
  return { text, ast: await loadAst() };
};

type PreparedProjectionEntry = {
  material: CorpusProjectionMaterial;
  documentCount: number;
  indexId: string;
  ndjson: string;
  ndjsonBytes: number;
  parts: readonly string[];
  leaseExpiresAtMs: number;
  appendMode: CorpusProjectionIntentLease["appendMode"];
};

type PreparedProjectionFailure = {
  kind: "payload_unavailable" | "revision_too_large";
  message: string;
};

export const classifyCorpusProjectionPayloadReadFailure = (
  error: unknown,
): PreparedProjectionFailure =>
  error instanceof PayloadBudgetError || error instanceof S3ObjectBudgetError
    ? {
        kind: "revision_too_large",
        message: "projection payload exceeds the transfer or decode ceiling",
      }
    : {
        kind: "payload_unavailable",
        message: "projection payload read failed before append",
      };

type PreparedProjectionRequest = {
  indexId: string;
  entries: readonly PreparedProjectionEntry[];
};

type ProjectionAppendPart = {
  indexId: string;
  ndjson: string;
  ndjsonBytes: number;
  leaseExpiresAtMs: number;
  appendMode?: CorpusProjectionIntentLease["appendMode"];
  parts?: readonly string[];
};

type ProjectionAppendTail<Entry extends ProjectionAppendPart> = {
  indexId: string;
  entries: Entry[];
  ndjsonBytes: number;
  earliestLeaseExpiresAtMs: number;
};

const CORPUS_PROJECTION_APPEND_START_MARGIN_MS =
  LIMITS.corpusObjectIoTimeoutMs + CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS;

type AdvanceProjectionAppendTailsOptions<Entry extends ProjectionAppendPart> = {
  tails: Map<string, ProjectionAppendTail<Entry>>;
  entries: readonly Entry[];
  mode: "buffer" | "flush-all";
  nowMs: number;
};

/**
 * Extend one serialized, byte-bounded tail per physical index in linear time.
 * A tail flushes when full or near its earliest lease deadline; serialization
 * and byte measurement are paid once per revision, not once per read window.
 *
 * `leaseMarginReached` separates the two reasons a tail flushed. A cap is a
 * property of the tail, so the next one fills from empty as before. The lease
 * margin is a property of the clock: once crossed it is true on every later
 * call, so a caller that keeps buffering past it gets one request per entry
 * rather than one per capful. Callers stop appending on it instead.
 */
export const advanceCorpusProjectionAppendTails = <
  Entry extends ProjectionAppendPart,
>({
  tails,
  entries,
  mode,
  nowMs,
}: AdvanceProjectionAppendTailsOptions<Entry>): {
  flush: ProjectionAppendTail<Entry>[];
  tails: Map<string, ProjectionAppendTail<Entry>>;
  leaseMarginReached: boolean;
} => {
  const nextTails = tails;
  const flush: ProjectionAppendTail<Entry>[] = [];
  const byIndex = new Map<string, Entry[]>();
  for (const entry of entries) {
    const group = byIndex.get(entry.indexId);
    if (group === undefined) {
      byIndex.set(entry.indexId, [entry]);
      continue;
    }
    group.push(entry);
  }
  for (const indexId of [...byIndex.keys()].toSorted()) {
    const group = byIndex.get(indexId) ?? panic("Lost projection entry group");
    for (const entry of group) {
      let tail = nextTails.get(indexId);
      if (entry.parts !== undefined && entry.parts.length > 1) {
        if (tail !== undefined) {
          flush.push(tail);
          nextTails.delete(indexId);
        }
        flush.push({
          indexId,
          entries: [entry],
          ndjsonBytes: entry.ndjsonBytes,
          earliestLeaseExpiresAtMs: entry.leaseExpiresAtMs,
        });
        continue;
      }
      if (
        tail !== undefined &&
        (tail.entries.length >= CORPUS_PROJECTION_APPEND_MAX_REVISIONS ||
          entry.appendMode === "single" ||
          tail.ndjsonBytes + entry.ndjsonBytes >
            CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES)
      ) {
        flush.push(tail);
        nextTails.delete(indexId);
        tail = undefined;
      }
      if (tail === undefined) {
        const next = {
          indexId,
          entries: [entry],
          ndjsonBytes: entry.ndjsonBytes,
          earliestLeaseExpiresAtMs: entry.leaseExpiresAtMs,
        };
        if (entry.appendMode === "single") {
          flush.push(next);
        } else {
          nextTails.set(indexId, next);
        }
        continue;
      }
      tail.entries.push(entry);
      tail.ndjsonBytes += entry.ndjsonBytes;
      tail.earliestLeaseExpiresAtMs = Math.min(
        tail.earliestLeaseExpiresAtMs,
        entry.leaseExpiresAtMs,
      );
    }
  }
  let leaseMarginReached = false;
  for (const [indexId, tail] of nextTails) {
    if (
      mode === "buffer" &&
      tail.earliestLeaseExpiresAtMs - nowMs >
        CORPUS_PROJECTION_APPEND_START_MARGIN_MS
    ) {
      continue;
    }
    leaseMarginReached = leaseMarginReached || mode === "buffer";
    flush.push(tail);
    nextTails.delete(indexId);
  }
  return { flush, tails: nextTails, leaseMarginReached };
};

/** The synchronous half of a prepared entry: payload in, append request out. */
const prepareProjectionEntry = (
  material: CorpusProjectionMaterial,
  payload: Awaited<ReturnType<typeof loadCorpusProjectionPayload>>,
): Result<PreparedProjectionEntry, PreparedProjectionFailure> => {
  const built = (() => {
    switch (material.family) {
      case "case_law":
        return buildCorpusProjectionDocuments({
          family: material.family,
          manifest: material.manifest,
          input: material.input,
          payload,
          revision: material.lease.intentId,
        });
      case "legislation":
        return buildCorpusProjectionDocuments({
          family: material.family,
          manifest: material.manifest,
          input: material.input,
          payload,
          revision: material.lease.intentId,
        });
      default:
        material satisfies never;
        return panic(`Unhandled material: ${String(material)}`);
    }
  })();
  if (built.isErr()) {
    return Result.err({
      kind: "revision_too_large",
      message: "projection payload exceeds the structural build ceiling",
    });
  }
  const entry = {
    revision: material.lease.intentId,
    documents: built.value,
  } satisfies CorpusProjectionAppendEntry;
  const planned = planCorpusProjectionAppendRequests([entry]);
  if (planned.isErr()) {
    if (planned.error.code === "revision_too_large") {
      return Result.err({
        kind: "revision_too_large",
        message: "projection revision exceeds the append safety ceiling",
      });
    }
    return panic(planned.error.message);
  }
  const request = planned.value.at(0);
  if (request === undefined) {
    return panic("Projection revision did not produce an append request");
  }
  return Result.ok({
    material,
    documentCount: entry.documents.length,
    indexId: material.lease.indexId,
    ndjson: request.ndjson,
    ndjsonBytes: Buffer.byteLength(request.ndjson, "utf-8") + 1,
    parts: planned.value.map(({ ndjson }) => ndjson),
    leaseExpiresAtMs: material.lease.leaseExpiresAt.getTime(),
    appendMode: material.lease.appendMode,
  });
};

type BuildPreparedEntryOptions = {
  runInTransaction: ProjectionTransactionRunner;
  material: CorpusProjectionMaterial;
  /** Records the synchronous build's share of the payload window. */
  recordBuildMs: (elapsedMs: number) => void;
  payloadReader: typeof loadCorpusProjectionPayload;
};

const buildPreparedEntry = async ({
  runInTransaction,
  material,
  recordBuildMs,
  payloadReader,
}: BuildPreparedEntryOptions): Promise<
  Result<PreparedProjectionEntry, PreparedProjectionFailure>
> => {
  // As in `prepareProjectionEntry`: without the `catch` mapper the cause is
  // wrapped, and every budget failure would classify as a transient
  // `payload_unavailable` and retry forever instead of blocking.
  const payload = await Result.tryPromise({
    try: async () => await payloadReader(runInTransaction, material),
    catch: (cause: unknown) => cause,
  });
  if (payload.isErr()) {
    return Result.err(
      classifyCorpusProjectionPayloadReadFailure(payload.error),
    );
  }
  // The build is synchronous, so one span covers all of it and the spans of
  // concurrent revisions cannot overlap.
  const buildStartedAt = Temporal.Now.instant().epochMilliseconds;
  const prepared = prepareProjectionEntry(material, payload.value);
  recordBuildMs(Temporal.Now.instant().epochMilliseconds - buildStartedAt);
  return prepared;
};

const addCancellation = (
  result: CorpusProjectionAppendCycleResult,
  cancellation: { cancelled: number; leaseLost: number },
): void => {
  result.cancelled += cancellation.cancelled;
  result.leaseLost += cancellation.leaseLost;
};

const recordAbandonedAppendResults = (
  result: CorpusProjectionAppendCycleResult,
  abandoned: {
    cleanupPending: number;
    leaseLost: number;
    blocked: readonly CorpusProjectionAppendAbandonResult[];
  },
): void => {
  result.unknownCleanupPending += abandoned.cleanupPending;
  result.blocked += abandoned.blocked.length;
  result.leaseLost += abandoned.leaseLost;
  for (const outcome of abandoned.blocked) {
    if (outcome.status === "blocked") {
      logger.warn("corpus_projection.append_blocked", {
        entity: outcome.entityId,
        kind: outcome.kind,
        attempts: outcome.attempts,
      });
    }
  }
};

type CorpusProjectionAppendFault = "document" | "engine";

/**
 * What a failed acceptance request says about the revisions it carried.
 *
 * - `outcome_unknown`: the request ran out of time. The engine may hold the
 *   revisions, so they are recorded as accepted and a census decides; a resend
 *   could apply them twice, and an expired budget is not an outage.
 * - `rejected`: the engine answered about the request's content. The revisions
 *   go to exact cleanup and retry, charged by `fault`.
 * - `engine_unavailable`: the engine is down or refusing work. Same cleanup,
 *   and the cycle backs off.
 */
type CorpusProjectionAppendFailure =
  | { kind: "outcome_unknown" }
  | { kind: "rejected"; fault: CorpusProjectionAppendFault }
  | { kind: "engine_unavailable"; fault: CorpusProjectionAppendFault };

const classifyAppendFailure = ({
  indexId,
  documents,
  revisionCount,
  error,
}: {
  indexId: string;
  documents: number;
  revisionCount: number;
  error: CorpusIndexError;
}): CorpusProjectionAppendFailure => {
  const failure = ((): CorpusProjectionAppendFailure => {
    if (isCorpusIndexRequestTimeout(error)) {
      return { kind: "outcome_unknown" };
    }
    const engineFault =
      error.rejection === "transient" ||
      error.cause !== undefined ||
      (error.status !== undefined &&
        error.status !== 400 &&
        error.status !== 413 &&
        error.status !== 422);
    // A batch 500 may come from one document. Isolate its members without
    // charging them, then charge a singleton 500 as an unknown outcome.
    const fault: CorpusProjectionAppendFault =
      !engineFault || error.status === 500 ? "document" : "engine";
    return engineFault && !(error.status === 500 && revisionCount === 1)
      ? { kind: "engine_unavailable", fault }
      : { kind: "rejected", fault };
  })();
  const event = (() => {
    switch (failure.kind) {
      case "outcome_unknown":
        return "corpus_projection.append_outcome_unknown";
      case "engine_unavailable":
        return "corpus_projection.engine_unavailable";
      case "rejected":
        return error.rejection === "definite"
          ? "corpus_projection.append_rejected"
          : "corpus_projection.append_unknown";
      default:
        failure satisfies never;
        return panic(`Unhandled append failure: ${String(failure)}`);
    }
  })();
  logger.warn(event, {
    indexId,
    documents,
    ...errorFingerprint(error),
  });
  return failure;
};

type AcceptStartedEntriesOptions = {
  runInTransaction: ProjectionTransactionRunner;
  entries: readonly PreparedProjectionEntry[];
  result: CorpusProjectionAppendCycleResult;
};

/** Record every started revision of one request as accepted, in one transaction. */
const acceptStartedEntries = async ({
  runInTransaction,
  entries,
  result,
}: AcceptStartedEntriesOptions): Promise<void> => {
  const counts = await measured(
    async () =>
      await runInTransaction(async (tx) => {
        const outcomes = await mapSequentially(
          entries,
          async (preparedEntry) =>
            await acceptCorpusProjectionAppendTx(tx, {
              intentId: preparedEntry.material.lease.intentId,
              leaseToken: preparedEntry.material.lease.leaseToken,
              documentCount: preparedEntry.documentCount,
            }),
        );
        const tally = { accepted: 0, staleCleanupPending: 0, leaseLost: 0 };
        for (const outcome of outcomes) {
          switch (outcome.status) {
            case "accepted":
              tally.accepted += 1;
              break;
            case "stale_cleanup_pending":
              tally.staleCleanupPending += 1;
              break;
            case "lease_lost":
              tally.leaseLost += 1;
              break;
            default:
              outcome satisfies never;
              panic(`Unhandled acceptance: ${String(outcome)}`);
          }
        }
        return tally;
      }),
    (elapsedMs) => {
      result.timing.storeCommitMs += elapsedMs;
    },
  );
  result.accepted += counts.accepted;
  result.staleCleanupPending += counts.staleCleanupPending;
  result.leaseLost += counts.leaseLost;
};

type AbandonStartedEntriesOptions = {
  runInTransaction: ProjectionTransactionRunner;
  entries: readonly PreparedProjectionEntry[];
  error: CorpusIndexError;
  fault: CorpusProjectionAppendFault;
  result: CorpusProjectionAppendCycleResult;
};

const abandonStartedEntries = async ({
  runInTransaction,
  entries,
  error,
  fault,
  result,
}: AbandonStartedEntriesOptions): Promise<{ blocked: number }> => {
  const abandoned = await runInTransaction(async (tx) => {
    const outcomes = await mapSequentially(
      entries,
      async (preparedEntry) =>
        await abandonCorpusProjectionAppendTx(tx, {
          intentId: preparedEntry.material.lease.intentId,
          leaseToken: preparedEntry.material.lease.leaseToken,
          errorMessage: error.message,
          rejection: error.rejection,
          fault,
        }),
    );
    return {
      cleanupPending: outcomes.filter(
        ({ status }) => status === "cleanup_pending",
      ).length,
      blocked: outcomes.filter(({ status }) => status === "blocked"),
      leaseLost: outcomes.filter(({ status }) => status === "lease_lost")
        .length,
    };
  });
  recordAbandonedAppendResults(result, abandoned);
  return { blocked: abandoned.blocked.length };
};

type ProcessPreparedRequestsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  requests: readonly PreparedProjectionRequest[];
  requestIndex: number;
  unattemptedLeases: readonly CorpusProjectionIntentLease[];
  result: CorpusProjectionAppendCycleResult;
};

const processPreparedRequests = async ({
  runInTransaction,
  client,
  requests,
  requestIndex,
  unattemptedLeases,
  result,
}: ProcessPreparedRequestsOptions): Promise<
  "completed" | "append_unknown" | "append_blocked" | "engine_unavailable"
> => {
  const request = requests.at(requestIndex);
  if (request === undefined) {
    return "completed";
  }
  const next = async () =>
    await processPreparedRequests({
      runInTransaction,
      client,
      requests,
      requestIndex: requestIndex + 1,
      unattemptedLeases,
      result,
    });
  const multipart =
    request.entries.length === 1 ? request.entries.at(0) : undefined;
  if (multipart !== undefined && multipart.parts.length > 1) {
    const laterLeases = requests
      .slice(requestIndex + 1)
      .flatMap(({ entries }) => entries.map(({ material }) => material.lease));
    const status = await processMultipartEntry({
      runInTransaction,
      client,
      entry: multipart,
      unattemptedLeases: [...laterLeases, ...unattemptedLeases],
      result,
    });
    if (status !== "completed") {
      return status;
    }
    return await next();
  }
  // Start one physical request as a batch. Its shared timestamp is read from
  // PostgreSQL only after all state locks are held, immediately before
  // external I/O; crash recovery cannot settle ahead of a late append.
  const starts = await measured(
    async () =>
      await runInTransaction(
        async (tx) =>
          await startCorpusProjectionAppendBatchTx(tx, {
            leases: request.entries.map(({ material }) => material.lease),
          }),
      ),
    (elapsedMs) => {
      result.timing.storeCommitMs += elapsedMs;
    },
  );
  result.cancelled += starts.filter(
    ({ status }) => status === "stale_cancelled",
  ).length;
  result.leaseLost += starts.filter(
    ({ status }) => status === "lease_lost",
  ).length;
  const entriesByIntent = new Map(
    request.entries.map((entry) => [entry.material.lease.intentId, entry]),
  );
  const started = starts.flatMap(({ intentId, status }) => {
    if (status !== "started") {
      return [];
    }
    return [
      entriesByIntent.get(intentId) ??
        panic(`Lost started projection revision ${intentId}`),
    ];
  });
  if (started.length === 0) {
    return await next();
  }
  result.requestCount += 1;
  const appended = await measured(
    async () =>
      await client.ingestQueuedBatch(
        request.indexId,
        started.map(({ ndjson }) => ndjson).join("\n"),
        "unobserved",
      ),
    (elapsedMs) => {
      result.timing.ingestMs += elapsedMs;
    },
  );
  if (appended.isOk()) {
    await acceptStartedEntries({ runInTransaction, entries: started, result });
    return await next();
  }
  const error: CorpusIndexError = appended.error;
  const failure = classifyAppendFailure({
    indexId: request.indexId,
    documents: started.length,
    revisionCount: started.length,
    error,
  });
  const stopCycle = async (
    status: "append_unknown" | "append_blocked" | "engine_unavailable",
  ) => {
    const laterLeases = requests
      .slice(requestIndex + 1)
      .flatMap(({ entries: laterEntries }) =>
        laterEntries.map(({ material }) => material.lease),
      );
    for (const lease of unattemptedLeases) {
      laterLeases.push(lease);
    }
    addCancellation(
      result,
      await cancelReservations({
        runInTransaction,
        leases: laterLeases,
        errorMessage: "projection append stopped after an unknown request",
      }),
    );
    result.status = status;
    if (status === "engine_unavailable") {
      result.cycleRetryDelayMs = CORPUS_PROJECTION_APPEND_RETRY_BASE_MS;
    }
    return status;
  };
  switch (failure.kind) {
    case "outcome_unknown":
      await acceptStartedEntries({
        runInTransaction,
        entries: started,
        result,
      });
      return await stopCycle("append_unknown");
    case "rejected": {
      const { blocked } = await abandonStartedEntries({
        runInTransaction,
        entries: started,
        error,
        fault: failure.fault,
        result,
      });
      return await stopCycle(blocked > 0 ? "append_blocked" : "append_unknown");
    }
    case "engine_unavailable":
      await abandonStartedEntries({
        runInTransaction,
        entries: started,
        error,
        fault: failure.fault,
        result,
      });
      return await stopCycle("engine_unavailable");
    default:
      failure satisfies never;
      return panic(`Unhandled append failure: ${String(failure)}`);
  }
};

type ProcessMultipartEntryOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  entry: PreparedProjectionEntry;
  unattemptedLeases: readonly CorpusProjectionIntentLease[];
  result: CorpusProjectionAppendCycleResult;
};

const processMultipartEntry = async ({
  runInTransaction,
  client,
  entry,
  unattemptedLeases,
  result,
}: ProcessMultipartEntryOptions): Promise<
  "completed" | "append_unknown" | "append_blocked" | "engine_unavailable"
> => {
  const lease = entry.material.lease;
  const cancelLater = async () => {
    addCancellation(
      result,
      await cancelReservations({
        runInTransaction,
        leases: unattemptedLeases,
        errorMessage: "projection append stopped after a multipart request",
      }),
    );
  };
  const stop = async ({
    errorMessage,
    rejection = "unknown",
    fault = "document",
    cycle = "append_unknown",
  }: {
    errorMessage: string;
    rejection?: CorpusIndexError["rejection"];
    fault?: CorpusProjectionAppendFault;
    cycle?: "append_unknown" | "engine_unavailable";
  }): Promise<"append_unknown" | "append_blocked" | "engine_unavailable"> => {
    const outcome = await runInTransaction(
      async (tx) =>
        await abandonCorpusProjectionAppendTx(tx, {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          errorMessage,
          rejection,
          fault,
        }),
    );
    switch (outcome.status) {
      case "cleanup_pending":
        result.unknownCleanupPending += 1;
        break;
      case "blocked":
        result.blocked += 1;
        logger.warn("corpus_projection.append_blocked", {
          entity: outcome.entityId,
          kind: outcome.kind,
          attempts: outcome.attempts,
        });
        break;
      case "lease_lost":
        result.leaseLost += 1;
        break;
      default:
        outcome satisfies never;
        panic(`Unhandled multipart abandon: ${String(outcome)}`);
    }
    await cancelLater();
    if (cycle === "engine_unavailable") {
      result.status = "engine_unavailable";
      result.cycleRetryDelayMs = CORPUS_PROJECTION_APPEND_RETRY_BASE_MS;
    } else if (outcome.status === "blocked") {
      result.status = "append_blocked";
    } else {
      result.status = "append_unknown";
    }
    return result.status;
  };
  const appendPart = async (
    partIndex: number,
  ): Promise<
    | "completed"
    | "skipped"
    | "append_unknown"
    | "append_blocked"
    | "engine_unavailable"
  > => {
    const ndjson = entry.parts.at(partIndex);
    if (ndjson === undefined) {
      return "completed";
    }
    const started = await measured(
      async () =>
        await runInTransaction(async (tx) =>
          partIndex === 0
            ? await startCorpusProjectionMultipartAppendTx(tx, lease)
            : await continueCorpusProjectionAppendPartTx(tx, lease),
        ),
      (elapsedMs) => {
        result.timing.storeCommitMs += elapsedMs;
      },
    );
    if (started !== "started") {
      if (partIndex > 0) {
        return await stop({
          errorMessage: "projection multipart append lost its lease",
        });
      }
      if (started === "stale_cancelled") {
        result.cancelled += 1;
      } else {
        result.leaseLost += 1;
      }
      return "skipped";
    }
    result.requestCount += 1;
    const appended = await measured(
      async () =>
        await client.ingestQueuedBatch(entry.indexId, ndjson, "unobserved"),
      (elapsedMs) => {
        result.timing.ingestMs += elapsedMs;
      },
    );
    if (appended.isOk()) {
      return await appendPart(partIndex + 1);
    }
    const failure = classifyAppendFailure({
      indexId: entry.indexId,
      documents: entry.documentCount,
      revisionCount: 1,
      error: appended.error,
    });
    switch (failure.kind) {
      case "outcome_unknown":
        if (partIndex === entry.parts.length - 1) {
          // Every earlier part was accepted, so the census can still find the
          // whole revision; resending the last part could duplicate it.
          await acceptStartedEntries({
            runInTransaction,
            entries: [entry],
            result,
          });
          await cancelLater();
          result.status = "append_unknown";
          return result.status;
        }
        // Later parts were never sent, so the revision can never be complete.
        return await stop({
          errorMessage: appended.error.message,
          rejection: appended.error.rejection,
          fault: "engine",
        });
      case "rejected":
        return await stop({
          errorMessage: appended.error.message,
          rejection: appended.error.rejection,
          fault: failure.fault,
        });
      case "engine_unavailable":
        return await stop({
          errorMessage: appended.error.message,
          rejection: appended.error.rejection,
          fault: failure.fault,
          cycle: "engine_unavailable",
        });
      default:
        failure satisfies never;
        return panic(`Unhandled multipart failure: ${String(failure)}`);
    }
  };
  const appendStatus = await appendPart(0);
  switch (appendStatus) {
    case "skipped":
      return "completed";
    case "completed":
      await acceptStartedEntries({
        runInTransaction,
        entries: [entry],
        result,
      });
      return "completed";
    case "append_unknown":
    case "append_blocked":
    case "engine_unavailable":
      return appendStatus;
    default:
      appendStatus satisfies never;
      return panic(`Unhandled multipart status: ${String(appendStatus)}`);
  }
};

type ProcessPreparedStreamOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  materialsReady: readonly CorpusProjectionMaterial[];
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
  result: CorpusProjectionAppendCycleResult;
  payloadReader: typeof loadCorpusProjectionPayload;
};

/**
 * Load payloads through a pool that refills as each read completes, and hand
 * each revision to the append machinery the moment its turn arrives.
 *
 * The pool replaces a window of concurrent reads. A window refilled only
 * once its slowest member settled and only after everything the window fed
 * had been appended, so effective read concurrency decayed to each window's
 * tail and fell to zero for the length of every append request. Reads now
 * continue through both. Look-ahead is capped at the same concurrency, so at
 * most that many payloads are in flight while that many prepared revisions
 * wait — the pair a window already held at its own peak.
 *
 * Revisions are still consumed in material order, so each physical index's
 * tail receives the same revisions in the same order and the appended ndjson
 * is unchanged. Failed reads are classified in one transaction per append
 * rather than one per revision.
 */
/** Leases still buffered in a tail, plus every material not yet consumed. */
const remainingLeases = (
  tails: Map<string, ProjectionAppendTail<PreparedProjectionEntry>>,
  consumed: number,
  materialsReady: readonly CorpusProjectionMaterial[],
): CorpusProjectionIntentLease[] => {
  const leases: CorpusProjectionIntentLease[] = [];
  for (const tail of tails.values()) {
    for (const { material } of tail.entries) {
      leases.push(material.lease);
    }
  }
  for (const { lease } of materialsReady.slice(consumed)) {
    leases.push(lease);
  }
  return leases;
};

const processPreparedStream = async ({
  runInTransaction,
  client,
  materialsReady,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
  result,
  payloadReader,
}: ProcessPreparedStreamOptions): Promise<
  "completed" | "append_unknown" | "append_blocked" | "engine_unavailable"
> => {
  let tails = new Map<string, ProjectionAppendTail<PreparedProjectionEntry>>();
  const pendingFailures: ReservationFailure[] = [];
  let consumed = 0;

  const classifyPendingFailures = async (): Promise<void> => {
    if (pendingFailures.length === 0) {
      return;
    }
    const classified = await classifyReservationFailures({
      runInTransaction,
      failures: pendingFailures.splice(0),
    });
    result.retryScheduled += classified.retryScheduled;
    result.blocked += classified.blocked;
    result.cancelled += classified.staleCancelled;
    result.leaseLost += classified.leaseLost;
  };

  const payloads = streamWithConcurrency({
    items: materialsReady,
    limit: payloadReadConcurrency,
    lookAhead: payloadReadConcurrency,
    operation: async (material) => ({
      material,
      prepared: await buildPreparedEntry({
        runInTransaction,
        material,
        recordBuildMs: (elapsedMs) => {
          result.timing.documentBuildMs += elapsedMs;
        },
        payloadReader,
      }),
    }),
  });

  let waitingSince = Temporal.Now.instant().epochMilliseconds;
  /** The margin-led flush to append once the pool is closed, if one came. */
  let marginFlush: ProjectionAppendTail<PreparedProjectionEntry>[] | undefined;
  for await (const { material, prepared } of payloads) {
    result.timing.payloadLoadMs +=
      Temporal.Now.instant().epochMilliseconds - waitingSince;
    consumed += 1;
    const entries: PreparedProjectionEntry[] = [];
    if (prepared.isOk()) {
      entries.push(prepared.value);
    } else if (prepared.error.kind === "payload_unavailable") {
      result.unread += 1;
      pendingFailures.push({
        lease: material.lease,
        failure: {
          status: "retry_scheduled",
          kind: prepared.error.kind,
          retryDelayMs,
          maxAttempts: payloadRetryLimit,
          message: prepared.error.message,
        },
      });
    } else {
      pendingFailures.push({
        lease: material.lease,
        failure: {
          status: "blocked",
          kind: prepared.error.kind,
          message: prepared.error.message,
        },
      });
    }

    // An append is the usual thing that persists the failures collected
    // beside it, but a batch whose payloads all fail never produces one. Left
    // to the end of the stream, those revisions would wait out every read in
    // the batch — long enough at the permitted batch size for their leases to
    // expire, at which point classification reports `lease_lost`, records no
    // attempt, and an unavailable payload retries forever instead of reaching
    // `blocked`. So drain on the same granularity the reads run at.
    if (pendingFailures.length >= payloadReadConcurrency) {
      // db-await-in-loop: one batched classification per drain, at the read concurrency (see above)
      await classifyPendingFailures();
    }

    const advanced = advanceCorpusProjectionAppendTails({
      tails,
      entries,
      mode: "buffer",
      nowMs: Temporal.Now.instant().epochMilliseconds,
    });
    tails = advanced.tails;
    if (advanced.leaseMarginReached) {
      // The lease is inside the margin an append needs to start safely, and it
      // only gets closer. Reading on would append one revision per request,
      // each paying a batch start, an ingest round trip and a commit for what
      // belongs in one capful, so the cycle stops here and hands the rest back
      // to a cycle whose lease can fill its requests.
      //
      // Breaking before the append is what stops the reads: closing the pool
      // ends the refill, so the cycle spends the ingest and commit appending
      // rather than reading payloads for revisions it has already given up.
      marginFlush = advanced.flush;
      break;
    }
    if (advanced.flush.length > 0) {
      // db-await-in-loop: one batched classification before each append
      await classifyPendingFailures();
      // db-await-in-loop: one ordered append per flushed capful, under the cycle's leases
      const requestStatus = await processPreparedRequests({
        runInTransaction,
        client,
        requests: advanced.flush,
        requestIndex: 0,
        unattemptedLeases: remainingLeases(tails, consumed, materialsReady),
        result,
      });
      if (requestStatus !== "completed") {
        return requestStatus;
      }
    }
    waitingSince = Temporal.Now.instant().epochMilliseconds;
  }

  if (marginFlush !== undefined) {
    await classifyPendingFailures();
    // The revisions this cycle will not attempt keep their reservations. Every
    // one of them is inside the start margin by construction, so they come
    // back on their own within it, and cancelling instead would spend a
    // statement per lease — up to the whole batch — holding a connection and
    // the shared fence to reclaim them barely sooner.
    return await processPreparedRequests({
      runInTransaction,
      client,
      requests: marginFlush,
      requestIndex: 0,
      unattemptedLeases: remainingLeases(tails, consumed, materialsReady),
      result,
    });
  }

  result.timing.payloadLoadMs +=
    Temporal.Now.instant().epochMilliseconds - waitingSince;
  await classifyPendingFailures();
  const final = advanceCorpusProjectionAppendTails({
    tails,
    entries: [],
    mode: "flush-all",
    nowMs: Temporal.Now.instant().epochMilliseconds,
  });
  return await processPreparedRequests({
    runInTransaction,
    client,
    requests: final.flush,
    requestIndex: 0,
    unattemptedLeases: [],
    result,
  });
};

/**
 * Execute one bounded append cycle. The operator chooses scope, cadence,
 * limits, and concurrency; this primitive owns durable ordering and exact
 * outcomes. It records acceptance only: no request waits a commit period, so
 * a backlog is bounded by payload and index throughput, and revisions become
 * applied when `confirmCorpusProjectionAppends` finds them searchable.
 */
export const executeCorpusProjectionAppendCycle = async <
  Family extends CorpusProjectionIntentLease["family"],
>({
  runInTransaction,
  client,
  family,
  generation,
  scope,
  limit,
  leaseMs,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
  payloadReader = loadCorpusProjectionPayload,
}: ExecuteCorpusProjectionAppendCycleOptions<Family>): Promise<CorpusProjectionAppendCycleResult> => {
  validateExecutorPolicy(
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
  );
  const timing: CorpusProjectionAppendCycleTiming = {
    reservationMs: 0,
    materialReadMs: 0,
    payloadLoadMs: 0,
    documentBuildMs: 0,
    ingestMs: 0,
    storeCommitMs: 0,
  };
  const { replacements, leases } = await measured(
    async () =>
      await runInTransaction(async (tx) => ({
        replacements: await prepareCorpusProjectionReplacementsTx(tx, {
          family,
          generation,
          scope,
          limit,
        }),
        leases: await reserveCorpusProjectionIntentsTx(tx, {
          family,
          generation,
          scope,
          limit,
          leaseMs,
        }),
      })),
    (elapsedMs) => {
      timing.reservationMs += elapsedMs;
    },
  );
  if (leases.length === 0) {
    return emptyResult(replacements.length, timing);
  }
  const result: CorpusProjectionAppendCycleResult = {
    ...emptyResult(replacements.length, timing),
    status: "completed",
    reserved: leases.length,
  };
  const materials = await measured(
    async () =>
      await runInTransaction(
        async (tx) =>
          await readReservedCorpusProjectionMaterialsTx(tx, { leases }),
      ),
    (elapsedMs) => {
      result.timing.materialReadMs += elapsedMs;
    },
  );
  const rejectedLeases = materials.rejected
    .filter(({ status }) => status === "stale")
    .map(({ lease }) => lease);
  result.leaseLost += materials.rejected.filter(
    ({ status }) => status === "lease_lost",
  ).length;
  const unreadableMaterials = materials.rejected.filter(
    ({ status }) => status === "unreadable",
  );
  result.unread += unreadableMaterials.length;
  addCancellation(
    result,
    await cancelReservations({
      runInTransaction,
      leases: rejectedLeases,
      errorMessage: "projection material is no longer readable or current",
    }),
  );
  const materialRetries = await classifyReservationFailures({
    runInTransaction,
    failures: unreadableMaterials.map(({ lease, reason }) => ({
      lease,
      failure: {
        status: "retry_scheduled",
        kind: "payload_unavailable",
        retryDelayMs,
        maxAttempts: payloadRetryLimit,
        message: reason,
      },
    })),
  });
  result.retryScheduled += materialRetries.retryScheduled;
  result.blocked += materialRetries.blocked;
  result.cancelled += materialRetries.staleCancelled;
  result.leaseLost += materialRetries.leaseLost;

  await processPreparedStream({
    runInTransaction,
    client,
    materialsReady: materials.ready,
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
    result,
    payloadReader,
  });
  if (result.status === "completed" && result.blocked > 0) {
    result.status = "append_blocked";
  }
  return result;
};
