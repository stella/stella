import { panic, type Result } from "better-result";
import { Buffer } from "node:buffer";

import { streamWithConcurrency } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/types";
import { errorFingerprint } from "@/api/lib/errors/utils";
import { drainCaseLawRankingSignalChanges } from "@/api/lib/legal-search/case-law-ranking-signal-drain";
import {
  type CorpusIndexClient,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusIndexManifest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_PROJECTION_APPEND_REQUEST_CAP_FULL,
  type CorpusIndexProjectionAppendRequestCap,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  corpusIndexCommitTimeoutSecs,
  type CorpusProjectionAppendCommitMode,
  corpusProjectionAppendStartMarginMs,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  type CorpusProjectionMaterial,
  readReservedCorpusProjectionMaterialsTx,
} from "@/api/lib/legal-search/corpus-index-projection-materials";
import {
  type CorpusProjectionProofCycleResult,
  executeCorpusProjectionProofCycle,
} from "@/api/lib/legal-search/corpus-index-projection-prover";
import {
  cancelCorpusProjectionReservations,
  classifyCorpusProjectionReservationFailures,
  type CorpusProjectionPayloadReader,
  type CorpusProjectionReservationFailureOfLease,
  type CorpusProjectionRevisionBlock,
  type CorpusProjectionRevisionBuildFailure,
  corpusProjectionRevisionBuildFailure,
  loadCorpusProjectionPayload,
  loadCorpusProjectionRevisionBlock,
  mapSequentially,
  settleRejectedCorpusProjectionMaterials,
  validateCorpusProjectionPayloadPolicy,
} from "@/api/lib/legal-search/corpus-index-projection-revision-block";
import type { CorpusProjectionAppendScopedWorkSelection } from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  abandonCorpusProjectionAppendTx,
  continueCorpusProjectionAppendPartTx,
  CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
  CORPUS_PROJECTION_LEASE_MAX_MS,
  CORPUS_PROJECTION_LEASE_MIN_MS,
  type CorpusProjectionAppendAbandonResult,
  type CorpusProjectionIntentLease,
  proveAcceptedCorpusProjectionAppendsTx,
  recordAcceptedCorpusProjectionAppendsTx,
  reserveCorpusProjectionIntentsTx,
  retireAcceptedCorpusProjectionAppendsTx,
  startCorpusProjectionAppendBatchTx,
  startCorpusProjectionMultipartAppendTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  countStoredAstOutcome,
  emptyStoredAstReadCounts,
  type StoredAstReadCounts,
} from "@/api/lib/legal-search/stored-ast-outcome";
import { logger } from "@/api/lib/observability/logger";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;
type ProjectionAppendClient = Pick<
  CorpusIndexClient,
  "ingestCommittedBatch" | "ingestQueuedBatch" | "aggregate"
>;

/**
 * Queued requests from existing coordinators also wait for publication. WAL
 * acceptance cannot authorize applied state, including during catch-up.
 */
export const ingestCorpusProjectionRequest = async (
  client: Pick<ProjectionAppendClient, "ingestCommittedBatch">,
  {
    commitMode,
    manifest,
    indexId,
    ndjson,
  }: {
    commitMode: CorpusProjectionAppendCommitMode;
    /** The generation the request writes; its commit window bounds the wait. */
    manifest: CorpusIndexManifest;
    indexId: string;
    ndjson: string;
  },
) => {
  switch (commitMode) {
    case CORPUS_PROJECTION_APPEND_COMMIT_MODE.published:
    case CORPUS_PROJECTION_APPEND_COMMIT_MODE.queued:
      return await client.ingestCommittedBatch({
        indexId,
        ndjson,
        observer: "unobserved",
        commitTimeoutSecs: corpusIndexCommitTimeoutSecs(manifest),
      });
    default:
      commitMode satisfies never;
      return panic(`Unhandled append commit mode: ${String(commitMode)}`);
  }
};

const measured = async <Value>(
  operation: () => Promise<Value>,
  record: (elapsedMs: number) => void,
): Promise<Value> => {
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  const value = await operation();
  record(Temporal.Now.instant().epochMilliseconds - startedAt);
  return value;
};

type ExecuteCorpusProjectionAppendCycleOptions<
  Family extends CorpusProjectionIntentLease["family"],
> = CorpusProjectionAppendScopedWorkSelection<Family> & {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  generation: string;
  /**
   * Coordinators may still request queued catch-up during rollout. Both
   * modes now wait for publication before confirming applied state.
   */
  commitMode: CorpusProjectionAppendCommitMode;
  limit: number;
  /**
   * How long the cycle may read and buffer before its first append must
   * start. The reservation lease is this plus the generation's start margin
   * (`corpusProjectionAppendLeaseMs`), so a long commit window never leaves a
   * cycle inside the margin before it has filled a request.
   */
  fillWindowMs: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
  /**
   * The previous cycle's `proof.afterIndexId`, or null: the cycle's proof pass
   * takes the next index after it, so passes rotate over the indexes in scope.
   */
  proofAfterIndexId: string | null;
  payloadReader?: CorpusProjectionPayloadReader;
};

/** Wall-clock milliseconds per phase, summed over the cycle, for the caller's logs. */
type CorpusProjectionAppendCycleTiming = {
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
  reserved: number;
  applied: number;
  staleCleanupPending: number;
  unknownCleanupPending: number;
  cancelled: number;
  leaseLost: number;
  unread: number;
  retryScheduled: number;
  blocked: number;
  /**
   * Revisions written with their decision's terms cut to a prefix because the
   * whole did not fit the opening passage. Expected to stay 0: no stored
   * decision comes near the ceiling, so any count is a decision to look at.
   */
  decisionTermsPartial: number;
  /** Revisions read whose stored AST was not read as written, by outcome. */
  storedAst: StoredAstReadCounts;
  requestCount: number;
  /** The proof cycle this append cycle ran before it reserved. */
  proof: CorpusProjectionProofCycleResult;
  timing: CorpusProjectionAppendCycleTiming;
};

type EmptyResultOptions = {
  proof: CorpusProjectionProofCycleResult;
  timing: CorpusProjectionAppendCycleTiming;
};

const emptyResult = ({
  proof,
  timing,
}: EmptyResultOptions): CorpusProjectionAppendCycleResult => ({
  status: "idle",
  cycleRetryDelayMs: null,
  proof,
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
  decisionTermsPartial: 0,
  storedAst: emptyStoredAstReadCounts(),
  requestCount: 0,
});

type PreparedProjectionEntry = {
  material: CorpusProjectionMaterial;
  documentCount: number;
  decisionTerms: CorpusProjectionRevisionBlock["decisionTerms"];
  storedAst: CorpusProjectionRevisionBlock["storedAst"];
  indexId: string;
  ndjson: string;
  ndjsonBytes: number;
  parts: readonly string[];
  leaseExpiresAtMs: number;
  appendRequestCap: CorpusIndexProjectionAppendRequestCap;
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
  /** The entity's request cap; a full request when absent. */
  appendRequestCap?: CorpusIndexProjectionAppendRequestCap;
  parts?: readonly string[];
};

type ProjectionAppendTail<Entry extends ProjectionAppendPart> = {
  indexId: string;
  entries: Entry[];
  ndjsonBytes: number;
  earliestLeaseExpiresAtMs: number;
};

/**
 * How long before its start margin a buffered tail flushes: the time its
 * start transaction may take to run after the cycle decides to send it. The
 * start refuses a lease inside the margin (`startCorpusProjectionAppendBatchTx`),
 * so flushing exactly at the margin would lose every margin-led request to
 * the start's own latency.
 */
export const CORPUS_PROJECTION_APPEND_START_LEAD_MS = 30_000;

/**
 * Requests of one cycle in flight at once. Each waits out the generation's
 * commit window, and every request issued inside one window is published by
 * the same commit, so a cycle sends its requests side by side instead of one
 * commit window each. Bounded so a reservation of many small requests cannot
 * open more connections or engine requests than this.
 */
export const CORPUS_PROJECTION_APPEND_REQUESTS_IN_FLIGHT = 16;

/** Lease remaining at which a buffered tail flushes. */
export const corpusProjectionAppendFlushMarginMs = (
  manifest: CorpusIndexManifest,
): number =>
  corpusProjectionAppendStartMarginMs(manifest) +
  CORPUS_PROJECTION_APPEND_START_LEAD_MS;

type CorpusProjectionAppendLeaseOptions = {
  manifest: CorpusIndexManifest;
  fillWindowMs: number;
};

/**
 * Reservation lease for an append cycle: the generation's flush margin plus
 * the time the cycle may spend filling its requests, capped at the store's
 * longest lease.
 *
 * A lease chosen without the margin silently degrades a long commit window
 * to one revision per request: every tail is inside the margin from the
 * moment it is reserved, so the cycle flushes its first revision and stops.
 * Deriving the lease here makes that state unrepresentable for every
 * generation and keeps the lease longer than the ingest it covers.
 */
export const corpusProjectionAppendLeaseMs = ({
  manifest,
  fillWindowMs,
}: CorpusProjectionAppendLeaseOptions): number => {
  if (
    !Number.isSafeInteger(fillWindowMs) ||
    fillWindowMs < CORPUS_PROJECTION_LEASE_MIN_MS
  ) {
    return panic(
      `Corpus projection fill window must be an integer of at least ${CORPUS_PROJECTION_LEASE_MIN_MS} ms`,
    );
  }
  return Math.min(
    corpusProjectionAppendFlushMarginMs(manifest) + fillWindowMs,
    CORPUS_PROJECTION_LEASE_MAX_MS,
  );
};

type AdvanceProjectionAppendTailsOptions<Entry extends ProjectionAppendPart> = {
  tails: Map<string, ProjectionAppendTail<Entry>>;
  entries: readonly Entry[];
  mode: "buffer" | "flush-all";
  nowMs: number;
  /** `corpusProjectionAppendFlushMarginMs` of the cycle's generation. */
  flushMarginMs: number;
};

/** One tail per physical index and request cap. */
const appendTailKey = (
  indexId: string,
  cap: CorpusIndexProjectionAppendRequestCap,
): string => `${indexId}\u0000${cap}`;

/**
 * Extend one serialized, byte-bounded tail per physical index and request cap
 * in linear time. A tail flushes when full (its cap, the request's revision
 * ceiling or its bytes) or near its earliest lease deadline; serialization
 * and byte measurement are paid once per revision, not once per read window.
 * Revisions of one cap travel together, so a reservation whose entities a
 * failed append capped is still sent in requests of that size, not one each.
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
  flushMarginMs,
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
      if (entry.parts !== undefined && entry.parts.length > 1) {
        flush.push({
          indexId,
          entries: [entry],
          ndjsonBytes: entry.ndjsonBytes,
          earliestLeaseExpiresAtMs: entry.leaseExpiresAtMs,
        });
        continue;
      }
      const cap =
        entry.appendRequestCap ??
        CORPUS_INDEX_PROJECTION_APPEND_REQUEST_CAP_FULL;
      const key = appendTailKey(indexId, cap);
      let tail = nextTails.get(key);
      if (
        tail !== undefined &&
        tail.ndjsonBytes + entry.ndjsonBytes >
          CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES
      ) {
        flush.push(tail);
        nextTails.delete(key);
        tail = undefined;
      }
      if (tail === undefined) {
        tail = {
          indexId,
          entries: [entry],
          ndjsonBytes: entry.ndjsonBytes,
          earliestLeaseExpiresAtMs: entry.leaseExpiresAtMs,
        };
        nextTails.set(key, tail);
      } else {
        tail.entries.push(entry);
        tail.ndjsonBytes += entry.ndjsonBytes;
        tail.earliestLeaseExpiresAtMs = Math.min(
          tail.earliestLeaseExpiresAtMs,
          entry.leaseExpiresAtMs,
        );
      }
      if (
        tail.entries.length >=
        Math.min(cap, CORPUS_PROJECTION_APPEND_MAX_REVISIONS)
      ) {
        flush.push(tail);
        nextTails.delete(key);
      }
    }
  }
  let leaseMarginReached = false;
  for (const [key, tail] of nextTails) {
    if (
      mode === "buffer" &&
      tail.earliestLeaseExpiresAtMs - nowMs > flushMarginMs
    ) {
      continue;
    }
    leaseMarginReached = leaseMarginReached || mode === "buffer";
    flush.push(tail);
    nextTails.delete(key);
  }
  return { flush, tails: nextTails, leaseMarginReached };
};

/** REST delivery of a revision block: its first request and its lease. */
const planProjectionRevisionRequest = ({
  material,
  documentCount,
  parts,
  decisionTerms,
  storedAst,
}: CorpusProjectionRevisionBlock): PreparedProjectionEntry => ({
  material,
  documentCount,
  decisionTerms,
  storedAst,
  indexId: material.lease.indexId,
  ndjson: parts[0],
  ndjsonBytes: Buffer.byteLength(parts[0], "utf-8") + 1,
  parts,
  leaseExpiresAtMs: material.lease.leaseExpiresAt.getTime(),
  appendRequestCap: material.lease.appendRequestCap,
});

type BuildPreparedEntryOptions = {
  runInTransaction: ProjectionTransactionRunner;
  material: CorpusProjectionMaterial;
  /** Records the synchronous build's share of the payload window. */
  recordBuildMs: (elapsedMs: number) => void;
  payloadReader: CorpusProjectionPayloadReader;
};

const buildPreparedEntry = async (
  options: BuildPreparedEntryOptions,
): Promise<
  Result<PreparedProjectionEntry, CorpusProjectionRevisionBuildFailure>
> =>
  (await loadCorpusProjectionRevisionBlock(options)).map(
    planProjectionRevisionRequest,
  );

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

const logAppendFailure = ({
  indexId,
  documents,
  revisionCount,
  error,
}: {
  indexId: string;
  documents: number;
  revisionCount: number;
  error: CorpusIndexError;
}): { fault: CorpusProjectionAppendFault; stopForEngine: boolean } => {
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
  const stopForEngine =
    engineFault && !(error.status === 500 && revisionCount === 1);
  let event = "corpus_projection.append_unknown";
  if (stopForEngine) {
    event = "corpus_projection.engine_unavailable";
  } else if (error.rejection === "definite") {
    event = "corpus_projection.append_rejected";
  }
  logger.warn(event, {
    indexId,
    documents,
    ...errorFingerprint(error),
  });
  return { fault, stopForEngine };
};

/** One request writes one physical index, so one generation. */
const requestManifest = (
  entries: readonly PreparedProjectionEntry[],
): CorpusIndexManifest =>
  entries.at(0)?.material.manifest ??
  panic("A projection append request carries no revision");

const PRESENCE_CONFIRMATION_FAILED =
  "projection append presence confirmation failed";
const PRESENCE_INCOMPLETE =
  "projection append is not fully searchable after publication";

type AcceptAndProveProjectionAppendOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  indexId: string;
  /** Revisions of one request the engine accepted. */
  entries: readonly PreparedProjectionEntry[];
  result: CorpusProjectionAppendCycleResult;
};

/**
 * Record an accepted request's revisions, then prove them at once: the request
 * waited for publication, so an exact count applies a revision. A revision the
 * census does not count exactly, or a census that fails, is retired through
 * the same transition with an uncharged retry, and the failure is returned so
 * the caller stops its chain as it does after an unknown request.
 */
const acceptAndProveProjectionAppend = async ({
  runInTransaction,
  client,
  indexId,
  entries,
  result,
}: AcceptAndProveProjectionAppendOptions): Promise<CorpusIndexError | null> => {
  const recorded = await measured(
    async () =>
      await runInTransaction(
        async (tx) =>
          await recordAcceptedCorpusProjectionAppendsTx(tx, {
            accepted: entries.map(({ material, documentCount }) => ({
              intentId: material.lease.intentId,
              leaseToken: material.lease.leaseToken,
              documentCount,
            })),
            delivery: { type: "ingest_api" },
          }),
      ),
    (elapsedMs) => {
      result.timing.storeCommitMs += elapsedMs;
    },
  );
  const documentCounts = new Map(
    entries.map(({ material, documentCount }) => [
      material.lease.intentId,
      documentCount,
    ]),
  );
  const accepted: {
    revision: CorpusProjectionIntentLease["intentId"];
    documentCount: number;
  }[] = [];
  for (const outcome of recorded) {
    switch (outcome.status) {
      case "accepted":
        accepted.push({
          revision: outcome.intentId,
          documentCount:
            documentCounts.get(outcome.intentId) ??
            panic(`Lost accepted projection revision ${outcome.intentId}`),
        });
        break;
      case "stale_cleanup_pending":
        result.staleCleanupPending += 1;
        break;
      case "lease_lost":
        result.leaseLost += 1;
        break;
      default:
        outcome satisfies never;
        panic(`Unhandled accepted append: ${String(outcome)}`);
    }
  }
  let failure: CorpusIndexError | null = null;
  for (const batch of chunkItems(
    accepted,
    CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  )) {
    const census = await measured(
      async () =>
        await proveCorpusProjectionRevisionsPresent({
          client,
          indexId,
          expected: batch,
        }),
      (elapsedMs) => {
        result.timing.ingestMs += elapsedMs;
      },
    );
    if (census.isErr()) {
      failure ??= new CorpusIndexError({
        message: PRESENCE_CONFIRMATION_FAILED,
        rejection: "transient",
        cause: census.error,
      });
    } else if (census.value.unproven.length > 0) {
      failure ??= new CorpusIndexError({
        message: PRESENCE_INCOMPLETE,
        rejection: "transient",
      });
    }
    const settled = await measured(
      async () =>
        await runInTransaction(async (tx) =>
          census.isOk()
            ? await proveAcceptedCorpusProjectionAppendsTx(tx, {
                indexId,
                census: census.value,
                timing: {
                  type: "request_waited",
                  failureMessage: PRESENCE_INCOMPLETE,
                },
              })
            : await retireAcceptedCorpusProjectionAppendsTx(tx, {
                indexId,
                revisions: batch,
                failureMessage: PRESENCE_CONFIRMATION_FAILED,
              }),
        ),
      (elapsedMs) => {
        result.timing.storeCommitMs += elapsedMs;
      },
    );
    for (const outcome of settled) {
      switch (outcome.status) {
        case "applied":
          result.applied += 1;
          break;
        case "stale_cleanup_pending":
          result.staleCleanupPending += 1;
          break;
        case "unproven_cleanup_pending":
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
        // An erasure moved it after the acceptance was recorded.
        case "already_applied":
        case "not_accepted":
          result.leaseLost += 1;
          break;
        case "awaiting_publication":
          return panic(`A waited request left ${outcome.intentId} unproven`);
        // Only an offline revision censused after its indexer ended is
        // withdrawn, and a waited request is never offline.
        case "withdrawn":
          return panic(`A waited request withdrew ${outcome.intentId}`);
        default:
          outcome satisfies never;
          return panic(`Unhandled inline proof: ${String(outcome)}`);
      }
    }
  }
  return failure;
};

/** How a request, and the chain of requests it belongs to, ended. */
type ProjectionAppendChainStatus =
  "completed" | "append_unknown" | "append_blocked" | "engine_unavailable";

/**
 * Which status a chain reports when its requests ended differently: an
 * unavailable engine also delays the next cycle, so it outranks a blocked
 * entity, which outranks an unknown outcome.
 */
const CHAIN_STATUS_RANK = {
  completed: 0,
  append_unknown: 1,
  append_blocked: 2,
  engine_unavailable: 3,
} as const satisfies Record<ProjectionAppendChainStatus, number>;

const worseChainStatus = (
  left: ProjectionAppendChainStatus,
  right: ProjectionAppendChainStatus,
): ProjectionAppendChainStatus =>
  CHAIN_STATUS_RANK[right] > CHAIN_STATUS_RANK[left] ? right : left;

/** The status a failed request reports. */
const failedRequestStatus = ({
  failure,
  blocked,
}: {
  failure: { stopForEngine: boolean };
  blocked: boolean;
}): Exclude<ProjectionAppendChainStatus, "completed"> => {
  if (failure.stopForEngine) {
    return "engine_unavailable";
  }
  return blocked ? "append_blocked" : "append_unknown";
};

/**
 * What one request did. `handBack` holds its revisions the start left
 * reserved because their lease no longer covered the start margin; the chain
 * cancels them when it ends, and starts nothing more.
 */
type ProjectionRequestOutcome = {
  status: ProjectionAppendChainStatus;
  handBack: readonly CorpusProjectionIntentLease[];
};

type ProcessPreparedRequestOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  commitMode: CorpusProjectionAppendCommitMode;
  request: PreparedProjectionRequest;
  result: CorpusProjectionAppendCycleResult;
};

/** Start, send, and record one physical request. */
const processPreparedRequest = async ({
  runInTransaction,
  client,
  commitMode,
  request,
  result,
}: ProcessPreparedRequestOptions): Promise<ProjectionRequestOutcome> => {
  const multipart =
    request.entries.length === 1 ? request.entries.at(0) : undefined;
  if (multipart !== undefined && multipart.parts.length > 1) {
    return await processMultipartEntry({
      runInTransaction,
      client,
      commitMode,
      entry: multipart,
      result,
    });
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
  const entriesByIntent = new Map(
    request.entries.map((entry) => [entry.material.lease.intentId, entry]),
  );
  const started: PreparedProjectionEntry[] = [];
  const handBack: CorpusProjectionIntentLease[] = [];
  for (const { intentId, status } of starts) {
    const entry =
      entriesByIntent.get(intentId) ??
      panic(`Lost started projection revision ${intentId}`);
    switch (status) {
      case "started":
        started.push(entry);
        break;
      case "stale_cancelled":
        result.cancelled += 1;
        break;
      case "lease_lost":
        result.leaseLost += 1;
        break;
      case "lease_ends_before_run":
        handBack.push(entry.material.lease);
        break;
      default:
        status satisfies never;
        panic(`Unhandled append start: ${String(status)}`);
    }
  }
  if (started.length === 0) {
    return { status: "completed", handBack };
  }
  result.requestCount += 1;
  const appended = await measured(
    async () =>
      await ingestCorpusProjectionRequest(client, {
        commitMode,
        manifest: requestManifest(started),
        indexId: request.indexId,
        ndjson: started.map(({ ndjson }) => ndjson).join("\n"),
      }),
    (elapsedMs) => {
      result.timing.ingestMs += elapsedMs;
    },
  );
  if (appended.isErr()) {
    const error: CorpusIndexError = appended.error;
    const failure = logAppendFailure({
      indexId: request.indexId,
      documents: started.length,
      revisionCount: started.length,
      error,
    });
    const abandoned = await runInTransaction(async (tx) => {
      const outcomes = await mapSequentially(
        started,
        async (preparedEntry) =>
          await abandonCorpusProjectionAppendTx(tx, {
            intentId: preparedEntry.material.lease.intentId,
            leaseToken: preparedEntry.material.lease.leaseToken,
            errorMessage: error.message,
            rejection: error.rejection,
            fault: failure.fault,
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
    return {
      status: failedRequestStatus({
        failure,
        blocked: abandoned.blocked.length > 0,
      }),
      handBack,
    };
  }

  const unproven = await acceptAndProveProjectionAppend({
    runInTransaction,
    client,
    indexId: request.indexId,
    entries: started,
    result,
  });
  if (unproven !== null) {
    return {
      status: failedRequestStatus({
        failure: logAppendFailure({
          indexId: request.indexId,
          documents: started.length,
          revisionCount: started.length,
          error: unproven,
        }),
        blocked: false,
      }),
      handBack,
    };
  }
  return { status: "completed", handBack };
};

type ProcessMultipartEntryOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  commitMode: CorpusProjectionAppendCommitMode;
  entry: PreparedProjectionEntry;
  result: CorpusProjectionAppendCycleResult;
};

/** One part's step: sent, refused before the first part, or stopped. */
type MultipartPartOutcome =
  | { type: "appended" }
  | { type: "not_started"; handBack: readonly CorpusProjectionIntentLease[] }
  | {
      type: "stopped";
      status: Exclude<ProjectionAppendChainStatus, "completed">;
    };

const processMultipartEntry = async ({
  runInTransaction,
  client,
  commitMode,
  entry,
  result,
}: ProcessMultipartEntryOptions): Promise<ProjectionRequestOutcome> => {
  const lease = entry.material.lease;
  const stop = async ({
    errorMessage,
    rejection = "unknown",
    fault = "document",
    stopForEngine = false,
  }: {
    errorMessage: string;
    rejection?: CorpusIndexError["rejection"];
    fault?: CorpusProjectionAppendFault;
    stopForEngine?: boolean;
  }): Promise<MultipartPartOutcome> => {
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
    return {
      type: "stopped",
      status: failedRequestStatus({
        failure: { stopForEngine },
        blocked: outcome.status === "blocked",
      }),
    };
  };
  const appendPart = async (
    partIndex: number,
  ): Promise<MultipartPartOutcome> => {
    const ndjson = entry.parts.at(partIndex);
    if (ndjson === undefined) {
      return { type: "appended" };
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
      switch (started) {
        case "stale_cancelled":
          result.cancelled += 1;
          return { type: "not_started", handBack: [] };
        case "lease_lost":
          result.leaseLost += 1;
          return { type: "not_started", handBack: [] };
        case "lease_ends_before_run":
          return { type: "not_started", handBack: [lease] };
        default:
          started satisfies never;
          return panic(`Unhandled multipart start: ${String(started)}`);
      }
    }
    result.requestCount += 1;
    const appended = await measured(
      async () =>
        await ingestCorpusProjectionRequest(client, {
          commitMode,
          manifest: entry.material.manifest,
          indexId: entry.indexId,
          ndjson,
        }),
      (elapsedMs) => {
        result.timing.ingestMs += elapsedMs;
      },
    );
    if (appended.isErr()) {
      const failure = logAppendFailure({
        indexId: entry.indexId,
        documents: entry.documentCount,
        revisionCount: 1,
        error: appended.error,
      });
      return await stop({
        errorMessage: appended.error.message,
        rejection: appended.error.rejection,
        fault: failure.fault,
        stopForEngine: failure.stopForEngine,
      });
    }
    return await appendPart(partIndex + 1);
  };
  const appendStatus = await appendPart(0);
  switch (appendStatus.type) {
    case "not_started":
      return { status: "completed", handBack: appendStatus.handBack };
    case "stopped":
      return { status: appendStatus.status, handBack: [] };
    case "appended":
      break;
    default:
      appendStatus satisfies never;
      return panic(`Unhandled multipart outcome: ${String(appendStatus)}`);
  }
  const unproven = await acceptAndProveProjectionAppend({
    runInTransaction,
    client,
    indexId: entry.indexId,
    entries: [entry],
    result,
  });
  if (unproven === null) {
    return { status: "completed", handBack: [] };
  }
  return {
    status: failedRequestStatus({
      failure: logAppendFailure({
        indexId: entry.indexId,
        documents: entry.documentCount,
        revisionCount: 1,
        error: unproven,
      }),
      blocked: false,
    }),
    handBack: [],
  };
};

type ProjectionAppendChain = {
  /** Whether the chain still starts requests. */
  accepting: () => boolean;
  /**
   * Send `requests` side by side, at most
   * `CORPUS_PROJECTION_APPEND_REQUESTS_IN_FLIGHT` at once. Resolves once each
   * has started running or been set aside, never waiting for a request to
   * finish unless every slot is taken.
   */
  submit: (requests: readonly PreparedProjectionRequest[]) => Promise<void>;
  /**
   * Wait for every request in flight to record its outcome, then hand back
   * every reservation the chain did not start, `unsent` included, and report
   * how the chain ended.
   */
  settle: (
    unsent: readonly CorpusProjectionIntentLease[],
  ) => Promise<ProjectionAppendChainStatus>;
};

type OpenProjectionAppendChainOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  commitMode: CorpusProjectionAppendCommitMode;
  result: CorpusProjectionAppendCycleResult;
};

const HAND_BACK_MESSAGE =
  "projection append handed back a reservation it did not start";

/**
 * The requests of one cycle. Each waits out the generation's commit window,
 * so they run side by side rather than one window each.
 *
 * A request that fails, whatever the reason, closes the chain to new starts;
 * requests already in flight still record their own outcomes. A start that
 * finds its lease inside the start margin closes it too: every lease of the
 * cycle shares one expiry and only gets closer to it. Whatever the chain did
 * not start, it cancels when it ends, so the revisions return to the queue
 * at their own position at once rather than when their lease expires.
 */
const openProjectionAppendChain = ({
  runInTransaction,
  client,
  commitMode,
  result,
}: OpenProjectionAppendChainOptions): ProjectionAppendChain => {
  /** Settlement of each request still running, by launch order. */
  const running = new Map<number, Promise<void>>();
  const outcomes: Promise<void>[] = [];
  const settlements: Promise<void>[] = [];
  const handBack: CorpusProjectionIntentLease[] = [];
  let launched = 0;
  let status: ProjectionAppendChainStatus = "completed";
  let accepting = true;

  const runRequest = async (request: PreparedProjectionRequest) => {
    const outcome = await processPreparedRequest({
      runInTransaction,
      client,
      commitMode,
      request,
      result,
    });
    handBack.push(...outcome.handBack);
    if (outcome.status !== "completed" || outcome.handBack.length > 0) {
      accepting = false;
    }
    status = worseChainStatus(status, outcome.status);
  };

  // Observed the moment the request starts, so a rejection behind a slower
  // request is never reported as unhandled; `settle` raises it from the
  // outcome itself. A request that threw is a defect, so the chain starts
  // nothing after it.
  const settleRequest = async (
    id: number,
    outcome: Promise<void>,
  ): Promise<void> => {
    const [settled] = await Promise.allSettled([outcome]);
    if (settled.status === "rejected") {
      accepting = false;
    }
    running.delete(id);
  };

  const launch = (request: PreparedProjectionRequest): void => {
    const id = launched;
    launched += 1;
    const outcome = runRequest(request);
    const settlement = settleRequest(id, outcome);
    running.set(id, settlement);
    outcomes.push(outcome);
    settlements.push(settlement);
  };

  const waitForSlot = async (): Promise<void> => {
    if (running.size < CORPUS_PROJECTION_APPEND_REQUESTS_IN_FLIGHT) {
      return;
    }
    await Promise.race(running.values());
    await waitForSlot();
  };

  const submitFrom = async (
    requests: readonly PreparedProjectionRequest[],
    index: number,
  ): Promise<void> => {
    const request = requests.at(index);
    if (request === undefined) {
      return;
    }
    await waitForSlot();
    if (accepting) {
      launch(request);
    } else {
      handBack.push(...request.entries.map(({ material }) => material.lease));
    }
    await submitFrom(requests, index + 1);
  };

  return {
    accepting: () => accepting,
    submit: async (requests) => {
      await submitFrom(requests, 0);
    },
    settle: async (unsent) => {
      accepting = false;
      await Promise.allSettled(settlements);
      addCancellation(
        result,
        await cancelCorpusProjectionReservations({
          runInTransaction,
          leases: [...handBack, ...unsent],
          errorMessage: HAND_BACK_MESSAGE,
        }),
      );
      // A request that threw is a defect, raised once every other request
      // has recorded its outcome and the reservations are handed back.
      await Promise.all(outcomes);
      return status;
    },
  };
};

type ProcessPreparedStreamOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  commitMode: CorpusProjectionAppendCommitMode;
  flushMarginMs: number;
  materialsReady: readonly CorpusProjectionMaterial[];
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
  result: CorpusProjectionAppendCycleResult;
  payloadReader: CorpusProjectionPayloadReader;
};

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
 * Revisions are consumed in material order, so each tail receives the same
 * revisions in the same order. Flushed requests run side by side in the
 * cycle's chain (`openProjectionAppendChain`); failed reads are classified in
 * one transaction per append rather than one per revision.
 */
const processPreparedStream = async ({
  runInTransaction,
  client,
  commitMode,
  flushMarginMs,
  materialsReady,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
  result,
  payloadReader,
}: ProcessPreparedStreamOptions): Promise<ProjectionAppendChainStatus> => {
  let tails = new Map<string, ProjectionAppendTail<PreparedProjectionEntry>>();
  const pendingFailures: CorpusProjectionReservationFailureOfLease[] = [];
  let consumed = 0;
  const chain = openProjectionAppendChain({
    runInTransaction,
    client,
    commitMode,
    result,
  });

  const classifyPendingFailures = async (): Promise<void> => {
    if (pendingFailures.length === 0) {
      return;
    }
    const classified = await classifyCorpusProjectionReservationFailures({
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
  let stoppedReading = false;
  for await (const { material, prepared } of payloads) {
    result.timing.payloadLoadMs +=
      Temporal.Now.instant().epochMilliseconds - waitingSince;
    consumed += 1;
    const entries: PreparedProjectionEntry[] = [];
    if (prepared.isOk()) {
      entries.push(prepared.value);
      countStoredAstOutcome(result.storedAst, prepared.value.storedAst);
      if (prepared.value.decisionTerms === "prefix") {
        result.decisionTermsPartial += 1;
        logger.error("corpus_projection.decision_terms_partial", {
          entity: material.lease.entityId,
          generation: material.lease.generation,
          indexId: material.lease.indexId,
        });
      }
    } else {
      if (prepared.error.kind === "payload_unavailable") {
        result.unread += 1;
      }
      pendingFailures.push(
        corpusProjectionRevisionBuildFailure(material.lease, prepared.error, {
          retryDelayMs,
          payloadRetryLimit,
        }),
      );
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
      flushMarginMs,
    });
    tails = advanced.tails;
    if (advanced.flush.length > 0) {
      // db-await-in-loop: one batched classification before each append
      await classifyPendingFailures();
      await chain.submit(advanced.flush);
    }
    // Past the flush margin the lease only gets closer to the start margin,
    // and reading on would append one revision per request; a chain a
    // request closed starts nothing more. Either way the cycle stops reading
    // here, which closes the pool, and hands the rest back when it ends.
    if (advanced.leaseMarginReached || !chain.accepting()) {
      stoppedReading = true;
      break;
    }
    waitingSince = Temporal.Now.instant().epochMilliseconds;
  }

  if (!stoppedReading) {
    result.timing.payloadLoadMs +=
      Temporal.Now.instant().epochMilliseconds - waitingSince;
    await classifyPendingFailures();
    const final = advanceCorpusProjectionAppendTails({
      tails,
      entries: [],
      mode: "flush-all",
      nowMs: Temporal.Now.instant().epochMilliseconds,
      flushMarginMs,
    });
    tails = final.tails;
    await chain.submit(final.flush);
  }
  await classifyPendingFailures();
  return await chain.settle(remainingLeases(tails, consumed, materialsReady));
};

/**
 * A cycle whose proof pass could not census reports that fault unless its
 * append part already reports a failure of its own, so it never reads as idle
 * or completed.
 */
const withProofFailure = (
  result: CorpusProjectionAppendCycleResult,
  proofFailure: { stopForEngine: boolean } | null,
): CorpusProjectionAppendCycleResult => {
  if (
    proofFailure === null ||
    (result.status !== "idle" && result.status !== "completed")
  ) {
    return result;
  }
  return proofFailure.stopForEngine
    ? {
        ...result,
        status: "engine_unavailable",
        cycleRetryDelayMs: CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
      }
    : { ...result, status: "append_unknown" };
};

/**
 * Execute one bounded append cycle. The operator chooses scope, cadence,
 * limits, concurrency, and what an acceptance means; this primitive owns
 * durable ordering and exact outcomes. Both commit modes wait for publication
 * on every request (`ingestCorpusProjectionRequest`), so each request holds
 * its chain for up to the generation's commit window.
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
  fillWindowMs,
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
  proofAfterIndexId,
  payloadReader = loadCorpusProjectionPayload,
}: ExecuteCorpusProjectionAppendCycleOptions<Family>): Promise<CorpusProjectionAppendCycleResult> => {
  validateCorpusProjectionPayloadPolicy({
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
  });
  const manifest = requireCorpusIndexManifest(family, generation);
  const leaseMs = corpusProjectionAppendLeaseMs({ manifest, fillWindowMs });
  const timing: CorpusProjectionAppendCycleTiming = {
    reservationMs: 0,
    materialReadMs: 0,
    payloadLoadMs: 0,
    documentBuildMs: 0,
    ingestMs: 0,
    storeCommitMs: 0,
  };
  // Committed revisions whose barrier has passed are proven before anything
  // is reserved, so one this or an earlier process recorded and never proved
  // converges here; its entity stays out of reservation until it is settled.
  const proof = await executeCorpusProjectionProofCycle({
    runInTransaction,
    client,
    family,
    generation,
    scope,
    afterIndexId: proofAfterIndexId,
  });
  // A census that failed settled nothing; it is reported as the engine fault
  // it is, and the append part still runs.
  const proofFailure =
    proof.status === "census_failed"
      ? logAppendFailure({
          indexId: proof.indexId,
          documents: proof.claimed,
          revisionCount: proof.claimed,
          error: proof.error,
        })
      : null;
  // A case-law cycle first reconciles a bounded batch of decisions whose
  // ranking signals moved, so a generation that stores them converges on the
  // corpus as it changes; their re-projections are reserved like any other.
  if (family === "case_law") {
    await drainCaseLawRankingSignalChanges({ runInTransaction });
  }
  const leases = await measured(
    async () =>
      await runInTransaction(
        async (tx) =>
          await reserveCorpusProjectionIntentsTx(tx, {
            family,
            generation,
            scope,
            limit,
            leaseMs,
          }),
      ),
    (elapsedMs) => {
      timing.reservationMs += elapsedMs;
    },
  );
  if (leases.length === 0) {
    return withProofFailure(emptyResult({ proof, timing }), proofFailure);
  }
  const result: CorpusProjectionAppendCycleResult = {
    ...emptyResult({ proof, timing }),
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
  const rejected = await settleRejectedCorpusProjectionMaterials({
    runInTransaction,
    rejected: materials.rejected,
    policy: { retryDelayMs, payloadRetryLimit },
  });
  result.cancelled += rejected.cancelled;
  result.leaseLost += rejected.leaseLost;
  result.unread += rejected.unread;
  result.retryScheduled += rejected.retryScheduled;
  result.blocked += rejected.blocked;

  const chainStatus = await processPreparedStream({
    runInTransaction,
    client,
    commitMode,
    flushMarginMs: corpusProjectionAppendFlushMarginMs(manifest),
    materialsReady: materials.ready,
    payloadReadConcurrency,
    retryDelayMs,
    payloadRetryLimit,
    result,
    payloadReader,
  });
  if (chainStatus !== "completed") {
    result.status = chainStatus;
  }
  if (chainStatus === "engine_unavailable") {
    result.cycleRetryDelayMs = CORPUS_PROJECTION_APPEND_RETRY_BASE_MS;
  }
  if (result.status === "completed" && result.blocked > 0) {
    result.status = "append_blocked";
  }
  return withProofFailure(result, proofFailure);
};
