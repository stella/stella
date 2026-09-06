import { panic, Result } from "better-result";
import { Buffer } from "node:buffer";

import type { Transaction } from "@/api/db/root";
import { PayloadBudgetError } from "@/api/lib/compression";
import { ChunkBudgetError } from "@/api/lib/corpus-index/chunking";
import { settleBoth } from "@/api/lib/corpus-index/core";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { buildCorpusProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import {
  CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
  CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS,
  planCorpusProjectionAppendRequests,
  type CorpusProjectionAppendCommitMode,
  type CorpusProjectionAppendEntry,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  readReservedCorpusProjectionMaterialsTx,
  type CorpusProjectionMaterial,
} from "@/api/lib/legal-search/corpus-index-projection-materials";
import type { CorpusProjectionAppendScopedWorkSelection } from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  abandonCorpusProjectionAppendTx,
  cancelCorpusProjectionReservationTx,
  classifyCorpusProjectionReservationFailureTx,
  commitCorpusProjectionAppendTx,
  CORPUS_PROJECTION_RETRY_MAX_MS,
  CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX,
  CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN,
  CORPUS_PROJECTION_RETRY_MIN_MS,
  prepareCorpusProjectionReplacementsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendBatchTx,
  type CorpusProjectionReservationFailure,
  type CorpusProjectionIntentLease,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  readCorpusAst,
  readCorpusAtAuthoritativePointer,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import { LIMITS } from "@/api/lib/limits";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { S3ObjectBudgetError } from "@/api/lib/s3";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;
type ProjectionAppendClient = Pick<
  CorpusIndexClient,
  "ingestCommittedBatch" | "ingestQueuedBatch"
>;

/**
 * The cycle's only mode-dependent step. Everything after it (the batch start,
 * the commit, the abandon on an unknown outcome) reads the same durable
 * state either way, so a queued cycle settles exactly like a published one.
 */
export const ingestCorpusProjectionRequest = async (
  client: ProjectionAppendClient,
  {
    commitMode,
    indexId,
    ndjson,
  }: {
    commitMode: CorpusProjectionAppendCommitMode;
    indexId: string;
    ndjson: string;
  },
) => {
  switch (commitMode) {
    case CORPUS_PROJECTION_APPEND_COMMIT_MODE.published:
      return await client.ingestCommittedBatch(indexId, ndjson);
    case CORPUS_PROJECTION_APPEND_COMMIT_MODE.queued:
      return await client.ingestQueuedBatch(indexId, ndjson);
    default:
      commitMode satisfies never;
      return panic(`Unhandled append commit mode: ${String(commitMode)}`);
  }
};

const measured = async <Value>(
  operation: () => Promise<Value>,
  record: (elapsedMs: number) => void,
): Promise<Value> => {
  const startedAt = Date.now();
  const value = await operation();
  record(Date.now() - startedAt);
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
  /**
   * Required, like the client's own `commit`: the two modes differ in what
   * the persisted acceptance means, and a default would let a caller inherit
   * the wrong one silently.
   */
  commitMode: CorpusProjectionAppendCommitMode;
  limit: number;
  leaseMs: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
};

/** Wall-clock milliseconds per phase, summed over the cycle, for the caller's logs. */
export type CorpusProjectionAppendCycleTiming = {
  reservationMs: number;
  materialReadMs: number;
  /**
   * The payload window end to end: object reads, which run concurrently, and
   * the document build for each revision, which does not.
   */
  payloadLoadMs: number;
  /**
   * The build's share of `payloadLoadMs`: parsing a payload into documents and
   * serializing them, summed over the revisions.
   *
   * Measured apart from the window it sits inside because the two answer
   * opposite questions. The window is wall clock over concurrent reads, so it
   * says nothing about where the time went; this is synchronous work on one
   * thread, so it adds up to real elapsed time and a cycle whose window is
   * mostly build is CPU-bound, not I/O-bound. Without the split the phase
   * reads as object-storage latency however it is actually spent.
   */
  documentBuildMs: number;
  ingestMs: number;
  storeCommitMs: number;
};

export type CorpusProjectionAppendCycleResult = {
  status: "idle" | "completed" | "append_unknown";
  replacementCleanupScheduled: number;
  reserved: number;
  applied: number;
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
  replacementCleanupScheduled,
  timing,
  reserved: 0,
  applied: 0,
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
  return await runInTransaction(async (tx) => {
    const outcomes = await mapSequentially(failures, async (failure) =>
      classifyCorpusProjectionReservationFailureTx(tx, {
        intentId: failure.lease.intentId,
        leaseToken: failure.lease.leaseToken,
        failure: failure.failure,
      }),
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
    };
  });
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
  if (material.family === "legislation" || material.astS3Key === null) {
    return { text: await textPromise, ast: null };
  }
  const astPromise = readCorpusAtAuthoritativePointer({
    storedKey: material.astS3Key,
    read: readCorpusAst,
    rereadStoredKey: async () => {
      const replacement = await current();
      return replacement?.family === "case_law" ? replacement.astS3Key : null;
    },
  });
  const [text, ast] = await settleBoth(textPromise, astPromise);
  return { text, ast };
};

type PreparedProjectionEntry = {
  material: CorpusProjectionMaterial;
  documentCount: number;
  indexId: string;
  ndjson: string;
  ndjsonBytes: number;
  leaseExpiresAtMs: number;
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
  for (const indexId of [...byIndex.keys()].sort()) {
    const group = byIndex.get(indexId) ?? panic("Lost projection entry group");
    for (const entry of group) {
      let tail = nextTails.get(indexId);
      if (
        tail !== undefined &&
        (tail.entries.length >= CORPUS_PROJECTION_APPEND_MAX_REVISIONS ||
          tail.ndjsonBytes + entry.ndjsonBytes >
            CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES)
      ) {
        flush.push(tail);
        nextTails.delete(indexId);
        tail = undefined;
      }
      if (tail === undefined) {
        nextTails.set(indexId, {
          indexId,
          entries: [entry],
          ndjsonBytes: entry.ndjsonBytes,
          earliestLeaseExpiresAtMs: entry.leaseExpiresAtMs,
        });
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
  for (const [indexId, tail] of nextTails) {
    if (
      mode === "buffer" &&
      tail.earliestLeaseExpiresAtMs - nowMs >
        CORPUS_PROJECTION_APPEND_START_MARGIN_MS
    ) {
      continue;
    }
    flush.push(tail);
    nextTails.delete(indexId);
  }
  return { flush, tails: nextTails };
};

/** The synchronous half of a prepared entry: payload in, append request out. */
const prepareProjectionEntry = (
  material: CorpusProjectionMaterial,
  payload: Awaited<ReturnType<typeof loadCorpusProjectionPayload>>,
): Result<PreparedProjectionEntry, PreparedProjectionFailure> => {
  const built = Result.try(() => {
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
  });
  if (built.isErr()) {
    if (built.error instanceof ChunkBudgetError) {
      return Result.err({
        kind: "revision_too_large",
        message: "projection payload exceeds the structural build ceiling",
      });
    }
    return panic("Corpus projection builder violated its manifest contract");
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
  if (request === undefined || planned.value.length !== 1) {
    return panic("One projection revision did not produce one append request");
  }
  return Result.ok({
    material,
    documentCount: entry.documents.length,
    indexId: material.lease.indexId,
    ndjson: request.ndjson,
    ndjsonBytes: Buffer.byteLength(request.ndjson, "utf-8") + 1,
    leaseExpiresAtMs: material.lease.leaseExpiresAt.getTime(),
  });
};

type BuildPreparedEntryOptions = {
  runInTransaction: ProjectionTransactionRunner;
  material: CorpusProjectionMaterial;
  /** Records the synchronous build's share of the payload window. */
  recordBuildMs: (elapsedMs: number) => void;
};

const buildPreparedEntry = async ({
  runInTransaction,
  material,
  recordBuildMs,
}: BuildPreparedEntryOptions): Promise<
  Result<PreparedProjectionEntry, PreparedProjectionFailure>
> => {
  const payload = await Result.tryPromise(
    async () => await loadCorpusProjectionPayload(runInTransaction, material),
  );
  if (payload.isErr()) {
    return Result.err(
      classifyCorpusProjectionPayloadReadFailure(payload.error),
    );
  }
  // The build is synchronous, so one span covers all of it and the spans of
  // concurrent revisions cannot overlap.
  const buildStartedAt = Date.now();
  const prepared = prepareProjectionEntry(material, payload.value);
  recordBuildMs(Date.now() - buildStartedAt);
  return prepared;
};

const addCancellation = (
  result: CorpusProjectionAppendCycleResult,
  cancellation: { cancelled: number; leaseLost: number },
): void => {
  result.cancelled += cancellation.cancelled;
  result.leaseLost += cancellation.leaseLost;
};

type ProcessPreparedRequestsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  commitMode: CorpusProjectionAppendCommitMode;
  requests: readonly PreparedProjectionRequest[];
  requestIndex: number;
  unattemptedLeases: readonly CorpusProjectionIntentLease[];
  result: CorpusProjectionAppendCycleResult;
};

const processPreparedRequests = async ({
  runInTransaction,
  client,
  commitMode,
  requests,
  requestIndex,
  unattemptedLeases,
  result,
}: ProcessPreparedRequestsOptions): Promise<"completed" | "append_unknown"> => {
  const request = requests.at(requestIndex);
  if (request === undefined) {
    return "completed";
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
    return await processPreparedRequests({
      runInTransaction,
      client,
      commitMode,
      requests,
      requestIndex: requestIndex + 1,
      unattemptedLeases,
      result,
    });
  }
  result.requestCount += 1;
  const appended = await measured(
    async () =>
      await ingestCorpusProjectionRequest(client, {
        commitMode,
        indexId: request.indexId,
        ndjson: started.map(({ ndjson }) => ndjson).join("\n"),
      }),
    (elapsedMs) => {
      result.timing.ingestMs += elapsedMs;
    },
  );
  if (appended.isErr()) {
    const abandoned = await runInTransaction(async (tx) => {
      const outcomes = await mapSequentially(
        started,
        async (preparedEntry) =>
          await abandonCorpusProjectionAppendTx(tx, {
            intentId: preparedEntry.material.lease.intentId,
            leaseToken: preparedEntry.material.lease.leaseToken,
            errorMessage: appended.error.message,
          }),
      );
      return {
        cleanupPending: outcomes.filter(
          (outcome) => outcome === "cleanup_pending",
        ).length,
        leaseLost: outcomes.filter((outcome) => outcome === "lease_lost")
          .length,
      };
    });
    result.unknownCleanupPending += abandoned.cleanupPending;
    result.leaseLost += abandoned.leaseLost;
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
    result.status = "append_unknown";
    return "append_unknown";
  }

  const committed = await measured(
    async () =>
      await runInTransaction(async (tx) => {
        const outcomes = await mapSequentially(
          started,
          async (preparedEntry) =>
            await commitCorpusProjectionAppendTx(tx, {
              intentId: preparedEntry.material.lease.intentId,
              leaseToken: preparedEntry.material.lease.leaseToken,
              documentCount: preparedEntry.documentCount,
            }),
        );
        const counts = { applied: 0, staleCleanupPending: 0, leaseLost: 0 };
        for (const outcome of outcomes) {
          switch (outcome.status) {
            case "applied":
              counts.applied += 1;
              break;
            case "stale_cleanup_pending":
              counts.staleCleanupPending += 1;
              break;
            case "lease_lost":
              counts.leaseLost += 1;
              break;
            default:
              outcome satisfies never;
              panic(`Unhandled outcome: ${String(outcome)}`);
          }
        }
        return counts;
      }),
    (elapsedMs) => {
      result.timing.storeCommitMs += elapsedMs;
    },
  );
  result.applied += committed.applied;
  result.staleCleanupPending += committed.staleCleanupPending;
  result.leaseLost += committed.leaseLost;
  return await processPreparedRequests({
    runInTransaction,
    client,
    commitMode,
    requests,
    requestIndex: requestIndex + 1,
    unattemptedLeases,
    result,
  });
};

type ProcessPreparedWindowsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  commitMode: CorpusProjectionAppendCommitMode;
  materialsReady: readonly CorpusProjectionMaterial[];
  tails: Map<string, ProjectionAppendTail<PreparedProjectionEntry>>;
  windowStart: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
  result: CorpusProjectionAppendCycleResult;
};

const processPreparedWindows = async ({
  runInTransaction,
  client,
  commitMode,
  materialsReady,
  tails,
  windowStart,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
  result,
}: ProcessPreparedWindowsOptions): Promise<"completed" | "append_unknown"> => {
  if (windowStart >= materialsReady.length) {
    const final = advanceCorpusProjectionAppendTails({
      tails,
      entries: [],
      mode: "flush-all",
      nowMs: Date.now(),
    });
    return await processPreparedRequests({
      runInTransaction,
      client,
      commitMode,
      requests: final.flush,
      requestIndex: 0,
      unattemptedLeases: [],
      result,
    });
  }
  // Payload I/O stays bounded by this window. Prepared entries then collect
  // only until the byte planner emits a full request; at most one request-
  // sized tail per physical index survives into the next window.
  const windowEnd = Math.min(
    windowStart + payloadReadConcurrency,
    materialsReady.length,
  );
  const window = materialsReady.slice(windowStart, windowEnd);
  const loaded = await measured(
    async () =>
      await Promise.all(
        window.map(async (material) => ({
          material,
          loaded: await buildPreparedEntry({
            runInTransaction,
            material,
            recordBuildMs: (elapsedMs) => {
              result.timing.documentBuildMs += elapsedMs;
            },
          }),
        })),
      ),
    (elapsedMs) => {
      result.timing.payloadLoadMs += elapsedMs;
    },
  );
  const preparationFailures: ReservationFailure[] = [];
  const prepared: PreparedProjectionEntry[] = [];
  for (const item of loaded) {
    if (item.loaded.isOk()) {
      prepared.push(item.loaded.value);
      continue;
    }
    const failure = item.loaded.error;
    if (failure.kind === "payload_unavailable") {
      result.unread += 1;
      preparationFailures.push({
        lease: item.material.lease,
        failure: {
          status: "retry_scheduled",
          kind: failure.kind,
          retryDelayMs,
          maxAttempts: payloadRetryLimit,
          message: failure.message,
        },
      });
      continue;
    }
    preparationFailures.push({
      lease: item.material.lease,
      failure: {
        status: "blocked",
        kind: failure.kind,
        message: failure.message,
      },
    });
  }
  const classified = await classifyReservationFailures({
    runInTransaction,
    failures: preparationFailures,
  });
  result.retryScheduled += classified.retryScheduled;
  result.blocked += classified.blocked;
  result.cancelled += classified.staleCancelled;
  result.leaseLost += classified.leaseLost;

  const advanced = advanceCorpusProjectionAppendTails({
    tails,
    entries: prepared,
    mode: "buffer",
    nowMs: Date.now(),
  });
  const unattemptedLeases = [...advanced.tails.values()].flatMap(
    ({ entries: tailEntries }) =>
      tailEntries.map(({ material }) => material.lease),
  );
  for (const { lease } of materialsReady.slice(windowEnd)) {
    unattemptedLeases.push(lease);
  }

  const requestStatus = await processPreparedRequests({
    runInTransaction,
    client,
    commitMode,
    requests: advanced.flush,
    requestIndex: 0,
    unattemptedLeases,
    result,
  });
  if (requestStatus === "append_unknown") {
    return requestStatus;
  }
  return await processPreparedWindows({
    runInTransaction,
    client,
    commitMode,
    materialsReady,
    tails: advanced.tails,
    windowStart: windowEnd,
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
    result,
  });
};

/**
 * Execute one bounded append cycle. Plane chooses scope, cadence, limits,
 * concurrency, and what an acceptance means; this primitive owns durable
 * ordering and exact outcomes. A queued cycle no longer waits a commit period
 * per request, so a backlog is bounded by payload and index throughput rather
 * than by in-flight requests times the commit period.
 */
export const executeCorpusProjectionAppendCycle = async <
  Family extends CorpusProjectionIntentLease["family"],
>({
  runInTransaction,
  client,
  commitMode,
  family,
  generation,
  scope,
  limit,
  leaseMs,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
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

  await processPreparedWindows({
    runInTransaction,
    client,
    commitMode,
    materialsReady: materials.ready,
    tails: new Map(),
    windowStart: 0,
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
    result,
  });
  return result;
};
