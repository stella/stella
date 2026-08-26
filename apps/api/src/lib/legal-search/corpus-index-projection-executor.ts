import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { PayloadBudgetError } from "@/api/lib/compression";
import { ChunkBudgetError } from "@/api/lib/corpus-index/chunking";
import { settleBoth } from "@/api/lib/corpus-index/core";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { buildCorpusProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import {
  planCorpusProjectionAppendRequests,
  type CorpusProjectionAppendEntry,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  readReservedCorpusProjectionMaterialsTx,
  type CorpusProjectionMaterial,
} from "@/api/lib/legal-search/corpus-index-projection-materials";
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
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { S3ObjectBudgetError } from "@/api/lib/s3";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;
type ProjectionAppendClient = Pick<CorpusIndexClient, "ingestCommittedBatch">;

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

type ExecuteCorpusProjectionAppendCycleOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  family: CorpusProjectionIntentLease["family"];
  generation: string;
  limit: number;
  leaseMs: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
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
};

const emptyResult = (
  replacementCleanupScheduled: number,
): CorpusProjectionAppendCycleResult => ({
  status: "idle",
  replacementCleanupScheduled,
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
  entry: CorpusProjectionAppendEntry;
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

type PreparedProjectionPlan = {
  requests: PreparedProjectionRequest[];
  blocked: PreparedProjectionEntry[];
};

const buildPreparedEntry = async (
  runInTransaction: ProjectionTransactionRunner,
  material: CorpusProjectionMaterial,
): Promise<Result<PreparedProjectionEntry, PreparedProjectionFailure>> => {
  const payload = await Result.tryPromise(
    async () => await loadCorpusProjectionPayload(runInTransaction, material),
  );
  if (payload.isErr()) {
    return Result.err(
      classifyCorpusProjectionPayloadReadFailure(payload.error),
    );
  }
  const built = Result.try(() => {
    switch (material.family) {
      case "case_law":
        return buildCorpusProjectionDocuments({
          manifest: material.manifest,
          input: material.input,
          payload: payload.value,
          revision: material.lease.intentId,
        });
      case "legislation":
        return buildCorpusProjectionDocuments({
          manifest: material.manifest,
          input: material.input,
          payload: payload.value,
          revision: material.lease.intentId,
        });
      default:
        return material satisfies never;
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
  return Result.ok({
    material,
    entry: { revision: material.lease.intentId, documents: built.value },
  });
};

const planPreparedRequests = (
  entries: readonly PreparedProjectionEntry[],
): PreparedProjectionPlan => {
  const eligible: PreparedProjectionEntry[] = [];
  const blocked: PreparedProjectionEntry[] = [];
  for (const prepared of entries) {
    const planned = planCorpusProjectionAppendRequests([prepared.entry]);
    if (planned.isOk()) {
      eligible.push(prepared);
      continue;
    }
    if (planned.error.code !== "revision_too_large") {
      return panic(planned.error.message);
    }
    blocked.push(prepared);
  }
  const byIndex = new Map<string, PreparedProjectionEntry[]>();
  for (const prepared of eligible) {
    const group = byIndex.get(prepared.material.lease.indexId);
    if (group === undefined) {
      byIndex.set(prepared.material.lease.indexId, [prepared]);
    } else {
      group.push(prepared);
    }
  }
  const requests: PreparedProjectionRequest[] = [];
  for (const indexId of [...byIndex.keys()].sort()) {
    const group = byIndex.get(indexId) ?? panic(`Lost projection index group`);
    const planned = planCorpusProjectionAppendRequests(
      group.map(({ entry }) => entry),
    );
    if (planned.isErr()) {
      return panic(planned.error.message);
    }
    const byRevision = new Map(
      group.map((prepared) => [prepared.entry.revision, prepared]),
    );
    for (const request of planned.value) {
      requests.push({
        indexId,
        entries: request.entries.map(
          ({ revision }) =>
            byRevision.get(revision) ??
            panic(`Lost planned projection revision ${revision}`),
        ),
      });
    }
  }
  return { requests, blocked };
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
  materialsReady: readonly CorpusProjectionMaterial[];
  requests: readonly PreparedProjectionRequest[];
  requestIndex: number;
  windowEnd: number;
  result: CorpusProjectionAppendCycleResult;
};

const processPreparedRequests = async ({
  runInTransaction,
  client,
  materialsReady,
  requests,
  requestIndex,
  windowEnd,
  result,
}: ProcessPreparedRequestsOptions): Promise<"completed" | "append_unknown"> => {
  const request = requests.at(requestIndex);
  if (request === undefined) {
    return "completed";
  }
  // Start one physical request as a batch. Its shared timestamp is read from
  // PostgreSQL only after all state locks are held, immediately before
  // external I/O; crash recovery cannot settle ahead of a late append.
  const starts = await runInTransaction(
    async (tx) =>
      await startCorpusProjectionAppendBatchTx(tx, {
        leases: request.entries.map(({ material }) => material.lease),
      }),
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
      materialsReady,
      requests,
      requestIndex: requestIndex + 1,
      windowEnd,
      result,
    });
  }
  const startedPlan = planCorpusProjectionAppendRequests(
    started.map(({ entry }) => entry),
  );
  if (startedPlan.isErr() || startedPlan.value.length !== 1) {
    return panic("Started projection request no longer fits its plan");
  }
  result.requestCount += 1;
  const appended = await client.ingestCommittedBatch(
    request.indexId,
    startedPlan.value.at(0)?.ndjson ??
      panic("Projection request plan is empty"),
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
    for (const { lease } of materialsReady.slice(windowEnd)) {
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

  const committed = await runInTransaction(async (tx) => {
    const outcomes = await mapSequentially(
      started,
      async (preparedEntry) =>
        await commitCorpusProjectionAppendTx(tx, {
          intentId: preparedEntry.material.lease.intentId,
          leaseToken: preparedEntry.material.lease.leaseToken,
          documentCount: preparedEntry.entry.documents.length,
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
      }
    }
    return counts;
  });
  result.applied += committed.applied;
  result.staleCleanupPending += committed.staleCleanupPending;
  result.leaseLost += committed.leaseLost;
  return await processPreparedRequests({
    runInTransaction,
    client,
    materialsReady,
    requests,
    requestIndex: requestIndex + 1,
    windowEnd,
    result,
  });
};

type ProcessPreparedWindowsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  materialsReady: readonly CorpusProjectionMaterial[];
  windowStart: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
  result: CorpusProjectionAppendCycleResult;
};

const processPreparedWindows = async ({
  runInTransaction,
  client,
  materialsReady,
  windowStart,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
  result,
}: ProcessPreparedWindowsOptions): Promise<"completed" | "append_unknown"> => {
  if (windowStart >= materialsReady.length) {
    return "completed";
  }
  // A window is fully classified and appended before the next payload is
  // read. Peak residency therefore follows Plane's bounded concurrency,
  // rather than the reservation limit of up to hundreds of documents.
  const windowEnd = Math.min(
    windowStart + payloadReadConcurrency,
    materialsReady.length,
  );
  const window = materialsReady.slice(windowStart, windowEnd);
  const loaded = await Promise.all(
    window.map(async (material) => ({
      material,
      loaded: await buildPreparedEntry(runInTransaction, material),
    })),
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
  const plan = planPreparedRequests(prepared);
  for (const { material } of plan.blocked) {
    preparationFailures.push({
      lease: material.lease,
      failure: {
        status: "blocked",
        kind: "revision_too_large",
        message: "projection revision exceeds the append safety ceiling",
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

  const requestStatus = await processPreparedRequests({
    runInTransaction,
    client,
    materialsReady,
    requests: plan.requests,
    requestIndex: 0,
    windowEnd,
    result,
  });
  if (requestStatus === "append_unknown") {
    return requestStatus;
  }
  return await processPreparedWindows({
    runInTransaction,
    client,
    materialsReady,
    windowStart: windowEnd,
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
    result,
  });
};

/**
 * Execute one bounded append cycle. Plane chooses scope, cadence, limits, and
 * concurrency; this primitive owns durable ordering and exact outcomes.
 */
export const executeCorpusProjectionAppendCycle = async ({
  runInTransaction,
  client,
  family,
  generation,
  limit,
  leaseMs,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
}: ExecuteCorpusProjectionAppendCycleOptions): Promise<CorpusProjectionAppendCycleResult> => {
  validateExecutorPolicy(
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
  );
  const { replacements, leases } = await runInTransaction(async (tx) => ({
    replacements: await prepareCorpusProjectionReplacementsTx(tx, {
      family,
      generation,
      limit,
    }),
    leases: await reserveCorpusProjectionIntentsTx(tx, {
      family,
      generation,
      limit,
      leaseMs,
    }),
  }));
  if (leases.length === 0) {
    return emptyResult(replacements.length);
  }
  const result: CorpusProjectionAppendCycleResult = {
    ...emptyResult(replacements.length),
    status: "completed",
    reserved: leases.length,
  };
  const materials = await runInTransaction(
    async (tx) => await readReservedCorpusProjectionMaterialsTx(tx, { leases }),
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
    materialsReady: materials.ready,
    windowStart: 0,
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
    result,
  });
  return result;
};
