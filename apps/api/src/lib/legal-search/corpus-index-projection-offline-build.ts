import { panic, Result } from "better-result";
import { and, count, eq, gt, inArray, max, min, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { rm } from "node:fs/promises";

import { streamWithConcurrency } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { sleep } from "@stll/concurrency/sleep";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusProjectionReservationQueueKey } from "@/api/lib/db/aggregate-lock";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusIndexManifest,
  requireCorpusIndexIdForManifest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { recoverExpiredCorpusProjectionIntentsTx } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import type { CorpusIndexAppendFault } from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  corpusIndexAppendPublishDelayMs,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { readReservedCorpusProjectionMaterialsTx } from "@/api/lib/legal-search/corpus-index-projection-materials";
import {
  CORPUS_PROJECTION_OFFLINE_MAX_WALK_PASSES,
  corpusProjectionOfflineBlockJoins,
  type CorpusProjectionOfflineBuildPolicy,
  type CorpusProjectionOfflineIngestedShard,
  corpusProjectionOfflineLeaseCanStart,
  corpusProjectionOfflineLoneKillJudgement,
  corpusProjectionOfflineNextShardClass,
  corpusProjectionOfflinePageLimit,
  type CorpusProjectionOfflinePlan,
  corpusProjectionOfflineShardCapAfterKill,
  corpusProjectionOfflineShardClass,
  corpusProjectionOfflineShardIsClosed,
  corpusProjectionOfflineShardName,
  corpusProjectionOfflineStopReservingAtMs,
  planCorpusProjectionOfflineBuild,
  validateCorpusProjectionOfflineRunId,
} from "@/api/lib/legal-search/corpus-index-projection-offline-plan";
import {
  type CorpusProjectionShardRange,
  type CorpusProjectionShardStaging,
  openCorpusProjectionShardStaging,
} from "@/api/lib/legal-search/corpus-index-projection-offline-shard-file";
import {
  executeCorpusProjectionProofCycle,
  proveCorpusProjectionRevisions,
} from "@/api/lib/legal-search/corpus-index-projection-prover";
import {
  CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS,
  corpusProjectionOfflineIndexerEndedAt,
  corpusProjectionOfflineIndexerKillDeadline,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  cancelCorpusProjectionReservations,
  classifyCorpusProjectionReservationFailures,
  type CorpusProjectionPayloadReader,
  type CorpusProjectionReservationFailureOfLease,
  corpusProjectionRevisionBuildFailure,
  loadCorpusProjectionPayload,
  loadCorpusProjectionRevisionBlock,
  settleRejectedCorpusProjectionMaterials,
  validateCorpusProjectionPayloadPolicy,
} from "@/api/lib/legal-search/corpus-index-projection-revision-block";
import {
  CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
  CORPUS_PROJECTION_APPEND_RETRY_CAP_MS,
  CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
  type CorpusProjectionIntentLease,
  type CorpusProjectionOfflineRequest,
  type CorpusProjectionOfflineStart,
  readCorpusProjectionOfflineRequestCapsTx,
  recordAcceptedCorpusProjectionAppendsTx,
  reserveCorpusProjectionRoutePageTx,
  startCorpusProjectionOfflineRequestChunkTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

/**
 * Build one route (family, generation, index) of a generation that is not
 * serving yet with the engine's offline indexer instead of its ingest API.
 *
 * The run drives the transitions the per-row path already uses and swaps
 * only the delivery: reserve (the per-entity claim) -> build each revision's
 * block once -> start offline with each revision's document count, before
 * any byte reaches the engine -> write the shard file -> deliver it through
 * the caller's indexer -> record every started revision, whatever the
 * delivery reported -> prove each by an exact census. The started rows are
 * the shard's manifest, so a crash at any step leaves rows the expired-lease
 * sweep and the prover settle with no manual step: a revision the indexer
 * published is applied, one it never published is withdrawn, and one it
 * published in part goes to cleanup.
 *
 * Only the census moves a revision. A delivery's outcome decides what its
 * failure costs, stored on each revision with its record
 * (`CORPUS_INDEX_APPEND_FAULTS`) so every prover decides it alike, and
 * whether the run goes on:
 * - `ingested`, or killed at its deadline with every revision exact (a merge
 *   at exit ran over): nothing failed (`documents`).
 * - a failure the runner reports as the indexer's: the documents decide, and
 *   the usual rules charge a revision only when it travelled alone
 *   (`documents`).
 * - a shard of several killed at its deadline with any revision short: too
 *   large for the true rate, or held up by one revision. Its revisions are
 *   never charged and their next requests halve (`killed`); the shard byte
 *   cap halves too (`corpusProjectionOfflineShardCapAfterKill`), and a cap
 *   that can no longer hold the largest revision stops the run
 *   (`rate_too_slow`).
 * - a lone revision killed short (`corpusProjectionOfflineLoneKillJudgement`):
 *   handed less than the plan's indexing window, nothing about it is known
 *   (`none`, `infrastructure_failed`); with the window, its own fault
 *   (`documents`), charged like a lone indexer failure, unless shards the run
 *   ingested to their end, each at least as large, achieved a rate that
 *   cannot index it in its budget (`none`, `rate_too_slow`).
 * - refused past its deadline, never delivered (a lost lock, a generation
 *   no longer building, no kill budget left), a failure the runner reports
 *   as infrastructure, or a census that cannot answer: nothing about the
 *   documents is known (`none`). Nobody is charged, no request halves, and
 *   the run stops (`infrastructure_failed`). A start that expires unrecorded
 *   (a crash, a rejected delivery) is committed by the sweep as `none` too.
 *
 * One shard file is one start request, admitted once and started in short
 * transactions inside the start window. An empty delivery cannot say which
 * revision, if any, was at fault, so a revision withdrawn from a request of
 * several stays batched, uncharged, and may start again only in a request of
 * at most half that size (`readCorpusProjectionOfflineRequestCapsTx`). Files
 * are grouped by request cap (`corpusProjectionOfflineShardClass`), so a
 * delivery failure halves exactly what failed together. A retired revision
 * that shared its request leaves its entity in single requests, which the
 * per-row path sends; the batch never reserves such an entity. One that
 * switched to single delivery after the batch reserved it starts alone.
 *
 * The walk is complete by construction. A reservation the run gives up
 * unstarted (a closed start window, a lease that ran out waiting, a row
 * another actor held) keeps its place in the queue, behind the walk's cursor,
 * so once a pass reaches the end of the queue the run drains its deliveries
 * and proofs and walks again from the head. It stops when a pass reserves
 * nothing, starts nothing (`no_progress`), or after
 * `CORPUS_PROJECTION_OFFLINE_MAX_WALK_PASSES` (`walk_pass_limit`). A pass
 * that reserves nothing ends the run `drained` only once nothing of the route
 * is outstanding either (no revision started or committed and undecided, by
 * any actor, the per-row path included). Until the run stops reserving, it
 * waits for the earliest instant an outstanding revision becomes decidable
 * (its lease ends, its barrier passes, its indexer has certainly ended),
 * then sweeps, proves and walks again; what is still outstanding after that
 * ends the run `awaiting_proof`, which the caller answers by running the
 * build again later: a later run, or the append cycle, settles those rows.
 *
 * What the caller provides:
 * - The route lock (`lock`) lives on a session of its own. `runInTransaction`
 *   never lends that connection, or any connection holding a session-level
 *   advisory lock: a start transaction refuses to run while its connection
 *   holds any lock (`requireFreshReadCommittedStartTx`), and runs in read
 *   committed.
 * - `deliver` resolves only once its indexer has exited, been killed or been
 *   refused, and enforces the shard's `killAfterMs` with a monotonic timer
 *   started before it launches the indexer, never by comparing its own clock
 *   with `killDeadline`. The hand-off is an in-process call: the time from
 *   `deliver` being called to that timer's start is not measured, and must
 *   stay well inside `CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS` (no
 *   job queue, no remote round trip in between). One indexer identity per slot is exclusive in time: a run starts
 *   delivering only after every offline run an earlier holder of the route
 *   started has certainly ended, and a run that fails keeps the lock until
 *   every delivery it handed out has certainly ended.
 */

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;
type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

/** One shard file the caller's indexer must deliver. */
export type CorpusProjectionOfflineShard = {
  /**
   * Unique across runs; the indexer's only identity for the file, so it is
   * never reused. Matches `[A-Za-z0-9._-]+`.
   */
  name: string;
  /** Absolute path of the NDJSON file, under the run's shard directory. */
  path: string;
  indexId: string;
  /**
   * The delivery slot, from 0. At most one delivery per slot is in flight,
   * and runs on one route never overlap in time (see the module comment), so
   * an indexer identity derived from the index and the slot is never used by
   * two processes at once.
   */
  slot: number;
  /**
   * The instant, on the database clock, by which the indexer must have been
   * killed. For records and logs only: the caller's host clock may differ
   * from the database's, so it enforces `killAfterMs` instead.
   */
  killDeadline: Date;
  /**
   * How long the indexer may run, measured on the database clock right
   * before the hand-off: `killDeadline` less that reading, always positive.
   * The caller starts a monotonic timer before it launches the indexer and
   * kills it when the timer reaches this, outside this process, so neither
   * this process nor its death can extend it, and no clock skew between the
   * hosts can either. The margin after `killDeadline` then only has to cover
   * a publish already in flight and the in-process hand-off from this call
   * to the timer's start, which the caller keeps well inside it.
   */
  killAfterMs: number;
  revisionCount: number;
  documentCount: number;
  bytes: number;
};

/**
 * What the caller's indexer reported for one shard. Timestamps are the
 * indexer host's clock: reported, never compared with the database clock.
 */
export type CorpusProjectionOfflineDeliveryOutcome =
  | { type: "ingested"; exitCode: 0; startedAt: Date; endedAt: Date }
  | {
      type: "failed";
      exitCode: number;
      /**
       * `indexer`: the indexer read the file and failed on what it held.
       * `infrastructure`: it could not run to its own verdict (it did not
       * launch, or its metastore or storage failed), so the failure says
       * nothing about the documents.
       */
      cause: "indexer" | "infrastructure";
      startedAt: Date;
      endedAt: Date;
    }
  | {
      type: "killed_at_deadline";
      exitCode: number | null;
      startedAt: Date;
      endedAt: Date;
    }
  /** The indexer refused the shard: its kill budget was already spent. */
  | { type: "deadline_passed"; refusedAt: Date };

/**
 * Deliver one shard through the offline indexer and resolve once it has
 * exited, been killed, or been refused. Start the kill timer at once, in this
 * process: the end margin covers only that hand-off (see `killAfterMs`). A
 * rejection is the end of the run: an
 * indexer it started may still be running under the slot's identity, so the
 * run keeps the route lock until that indexer's kill deadline has passed.
 */
export type CorpusProjectionOfflineDelivery = (
  shard: CorpusProjectionOfflineShard,
) => Promise<CorpusProjectionOfflineDeliveryOutcome>;

/** A held per-route lock, released when its session ends. */
export type CorpusProjectionOfflineBuildLockHold = {
  /** Whether the session still holds the lock; asked before each delivery. */
  stillHeld: () => Promise<boolean>;
  release: () => Promise<void>;
};

/**
 * The caller's session-level advisory lock, on a session of its own that no
 * transaction of the run borrows. One run per route holds it.
 */
export type CorpusProjectionOfflineBuildLock = {
  tryAcquire: (key: {
    domain: string;
    name: string;
  }) => Promise<CorpusProjectionOfflineBuildLockHold | null>;
};

/** One unit of database work the caller's load governor admits. */
export type CorpusProjectionOfflineWorkUnit = {
  /**
   * `start` covers every start transaction of one request, so the governor
   * can never hold a request's later transactions past its start window.
   */
  phase: "recover" | "reserve" | "start" | "record" | "prove";
  /** Revisions the unit touches, the governor's weight. */
  revisions: number;
};

/**
 * The caller's admission: run `work` once the governor admits the unit, and
 * hold the admission until it settles. The run never knows how the governor
 * decides; it only waits.
 */
export type CorpusProjectionOfflineAdmission = <Value>(
  unit: CorpusProjectionOfflineWorkUnit,
  work: () => Promise<Value>,
) => Promise<Value>;

export type CorpusProjectionOfflineBuildOptions<Family extends CorpusFamily> = {
  runInTransaction: ProjectionTransactionRunner;
  /** Census client of an engine endpoint that reads the route's index. */
  client: Pick<CorpusIndexClient, "aggregate">;
  family: Family;
  generation: string;
  indexId: string;
  /** `[A-Za-z0-9._-]`, at most 64 characters; prefixes every shard name. */
  runId: string;
  /** Absolute directory the shard files are written to. */
  shardDirectory: string;
  /** No work is reserved after `deadline` less the plan's stop margin. */
  deadline: Date;
  policy: CorpusProjectionOfflineBuildPolicy;
  deliver: CorpusProjectionOfflineDelivery;
  lock: CorpusProjectionOfflineBuildLock;
  admit: CorpusProjectionOfflineAdmission;
  /**
   * Where the first pass starts: a previous run's `progress.cursor`, or null
   * for the head. Later passes always start from the head.
   */
  resumeAfter: CorpusProjectionReservationQueueKey | null;
  /** Called after every shard and proof pass with the progress so far. */
  onProgress?: (progress: CorpusProjectionOfflineBuildProgress) => void;
  /** Deterministic seams for database tests. */
  testing?: {
    /** A clock aligned with the test database; also each statement's time. */
    clock: () => Promise<Date>;
    sleep: (milliseconds: number) => Promise<void>;
    payloadReader?: CorpusProjectionPayloadReader;
    newShardId?: () => string;
  };
};

/** What a run did, in revisions unless named otherwise. */
export type CorpusProjectionOfflineBuildProgress = {
  /** Where the walk stands in its current pass. */
  cursor: CorpusProjectionReservationQueueKey | null;
  walk: {
    /** Passes over the queue so far, the current one included. */
    passes: number;
    /** What the last finished pass reserved and started. */
    lastPassReserved: number;
    lastPassStarted: number;
  };
  reserved: number;
  /**
   * The most built blocks held at once for a later shard of their class: at
   * most one reservation page, since a page is reserved only while none wait.
   */
  waitingPeak: number;
  /** Reservations that ended before a start, and why. */
  notStarted: {
    /** Material or desired state moved, or the lease was too short to start. */
    cancelled: number;
    leaseLost: number;
    /** Payload unreadable; retried later under the retry limit. */
    retryScheduled: number;
    /** Payload over a ceiling, or retry limit reached. */
    blocked: number;
    /**
     * Handed back unstarted: a page's blocks over one shard's bytes, a
     * request's start window closed, or a lease that would end before the
     * request's run and record. A later pass of the same run takes them.
     */
    handedBack: number;
  };
  started: number;
  shards: {
    delivered: number;
    ingested: number;
    /** Killed at the deadline with every revision exact: a merge ran over. */
    mergeOverruns: number;
    /** Shards of several killed with revisions short: too large. */
    killedTooLarge: number;
    /** Lone revisions killed short, charged as their own fault. */
    killedAlone: number;
    /** Failed on what the file held. */
    indexerFailures: number;
    /** Refused, undelivered, or failed outside the documents. */
    infrastructureFailures: number;
    /** Files of revisions an earlier empty delivery capped. */
    capped: number;
    /**
     * Bytes and indexer time of every shard the indexer ran to its end or to
     * its kill: their quotient bounds the true rate from above.
     */
    attemptedBytes: number;
    attemptedMs: number;
    /** The shard byte cap now; it halves after a shard killed too large. */
    shardByteCap: number;
  };
  recorded: number;
  /** Applied by this run's proof. */
  proved: number;
  /**
   * Absent once the indexer had certainly ended; no delete owed. The entity
   * is reserved again, by a later pass, in a request of at most half the one
   * it was withdrawn from.
   */
  withdrawn: number;
  /** Queued for a delete: inexact, or desired state moved. */
  sentToCleanup: number;
  /**
   * Retired revisions that shared their request, whose entity the proof left
   * in single requests: the per-row path owns those entities now. A
   * withdrawn revision stays with the batch, in a smaller request.
   */
  perRowHandoffs: number;
  blockedByProof: number;
  /** Decided by another actor (another prover, the sweep, an erasure). */
  superseded: number;
  /** Recorded revisions still waiting for a final census at the end. */
  awaitingProof: number;
  /**
   * Revisions of the route, by any actor, still started or committed and
   * undecided, counted once a pass reserved nothing. Zero whenever the run
   * ends `drained`.
   */
  outstanding: number;
  censusFailures: number;
  /**
   * Rows of earlier runs this run settled: expired leases its sweep
   * recovered and committed revisions its recovery proof decided.
   */
  recovered: number;
};

export type CorpusProjectionOfflineBuildOutcome = {
  /**
   * - `drained`: a full pass over the queue reserved nothing, and nothing of
   *   the route is outstanding.
   * - `awaiting_proof`: a full pass reserved nothing, but revisions of the
   *   route, by any actor, are still started or committed and undecided, and
   *   none becomes decidable before the run stops reserving
   *   (`progress.outstanding`). The caller runs the build again later; that
   *   run, or the append cycle, settles them. Nothing is lost meanwhile.
   * - `no_progress`: a full pass reserved work but started none of it.
   * - `walk_pass_limit`: the run walked the queue its most times and the
   *   last pass still found work.
   * - `rate_too_slow`: a shard was killed too large and half of it no longer
   *   holds the largest revision.
   * - `infrastructure_failed`: a delivery failed outside its documents.
   */
  status:
    | "drained"
    | "awaiting_proof"
    | "no_progress"
    | "walk_pass_limit"
    | "deadline_reached"
    | "lock_held"
    | "lock_lost"
    | "generation_not_building"
    | "rate_too_slow"
    | "infrastructure_failed";
  progress: CorpusProjectionOfflineBuildProgress;
};

/** The advisory lock key of a route's offline build. */
const lockKeyOf = (
  family: CorpusFamily,
  generation: string,
  indexId: string,
) => ({
  domain: "corpus-projection-offline-build",
  name: `${family}:${generation}:${indexId}`,
});

/**
 * Refuse to start offline revisions in a transaction that is not fresh and
 * read committed. The store's first lock in a start transaction is the
 * request's advisory lock, which serializes the request's starts; it must be
 * the transaction's first lock, since row locks taken earlier with plain
 * `FOR UPDATE` could close a cycle with another start of the same request
 * that the lock ranks do not see. And the count of what the request already
 * started is read after that lock, which only read committed sees in full:
 * a repeatable-read snapshot would predate the wait.
 *
 * A transaction that has locked a row holds its own transaction id lock, so
 * no advisory and no transaction id lock means nothing was locked yet. A
 * connection that holds a session-level advisory lock (the route lock among
 * them) is refused too, which is why that lock lives on a session of its own.
 */
export const requireFreshReadCommittedStartTx = async (
  tx: Transaction,
): Promise<void> => {
  const [probe] = await tx
    .select({
      isolation: sql<string>`current_setting('transaction_isolation')`,
      locksHeld: sql<number>`(
        SELECT count(*)::integer
        FROM pg_locks
        WHERE pid = pg_backend_pid()
          AND granted
          AND locktype IN ('advisory', 'transactionid', 'tuple')
      )`,
    })
    .from(sql`(SELECT 1) AS probe`);
  if (probe === undefined) {
    return panic("The start transaction probe returned no row");
  }
  if (probe.isolation !== "read committed") {
    return panic(
      `An offline start must run in read committed, not ${probe.isolation}`,
    );
  }
  if (probe.locksHeld !== 0) {
    return panic(
      "An offline start must take the request's lock first, in a transaction that holds no lock yet",
    );
  }
};

/**
 * Entities of `leases` whose state now delivers alone. The reservation takes
 * only batchable entities, but a state can switch to single delivery after
 * it (a shared delivery of the entity retired), and the offline start does
 * not refuse such a revision in a larger request, so the run composes its
 * requests from what the state says when the revision is built.
 */
const readSingleDeliveryEntitiesTx = async (
  tx: Transaction,
  leases: readonly CorpusProjectionIntentLease[],
): Promise<Set<string>> => {
  const first = leases.at(0);
  if (first === undefined) {
    return new Set();
  }
  const rows = await tx
    .select({ entityId: corpusIndexProjectionStates.entityId })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, first.family),
        eq(corpusIndexProjectionStates.generation, first.generation),
        inArray(corpusIndexProjectionStates.entityId, [
          ...new Set(leases.map(({ entityId }) => entityId)),
        ]),
        eq(corpusIndexProjectionStates.appendMode, "single"),
      ),
    );
  return new Set(rows.map(({ entityId }) => entityId));
};

/** Expired-lease sweep pages a run takes at its start and every few shards. */
const SWEEP_MAX_PAGES = 8;
const SWEEP_EVERY_SHARDS = 8;
/** Proof cycles a run takes at its start for an earlier run's revisions. */
const RECOVERY_PROOF_MAX_PASSES = 8;

const emptyProgress = (
  cursor: CorpusProjectionReservationQueueKey | null,
  shardByteCap: number,
): CorpusProjectionOfflineBuildProgress => ({
  cursor,
  walk: { passes: 1, lastPassReserved: 0, lastPassStarted: 0 },
  reserved: 0,
  waitingPeak: 0,
  notStarted: {
    cancelled: 0,
    leaseLost: 0,
    retryScheduled: 0,
    blocked: 0,
    handedBack: 0,
  },
  started: 0,
  shards: {
    delivered: 0,
    ingested: 0,
    mergeOverruns: 0,
    killedTooLarge: 0,
    killedAlone: 0,
    indexerFailures: 0,
    infrastructureFailures: 0,
    capped: 0,
    attemptedBytes: 0,
    attemptedMs: 0,
    shardByteCap,
  },
  recorded: 0,
  proved: 0,
  withdrawn: 0,
  sentToCleanup: 0,
  perRowHandoffs: 0,
  blockedByProof: 0,
  superseded: 0,
  awaitingProof: 0,
  outstanding: 0,
  censusFailures: 0,
  recovered: 0,
});

/** One built revision, in a shard's staging file or waiting for the next one. */
type ShardEntry = {
  lease: CorpusProjectionIntentLease;
  documentCount: number;
  range: CorpusProjectionShardRange;
};

/** A built block waiting for a shard of its class. */
type CarriedBlock = {
  lease: CorpusProjectionIntentLease;
  documentCount: number;
  block: string;
  bytes: number;
  /** `corpusProjectionOfflineShardClass` of its request cap. */
  shardClass: number;
};

/** A shard before its hand-off, which measures its kill budget. */
type StartedShardFile = Omit<CorpusProjectionOfflineShard, "killAfterMs">;

type StartedShard = {
  shard: StartedShardFile;
  entries: ShardEntry[];
  startedAt: Date;
  shardClass: number;
};

/** A recorded revision this run still has to see decided. */
type PendingProof = {
  /** Census it no earlier than this, on the run's clock. */
  notBeforeMs: number;
  /** When its indexer has certainly ended, on the database clock. */
  endedAtMs: number;
  /** Revisions its start request held. */
  requestSize: number;
  /**
   * What its record stored a failure is charged to; a retirement from a
   * request of several isolates the entity only when it is `documents`.
   */
  fault: CorpusIndexAppendFault;
};

type Stop = Exclude<CorpusProjectionOfflineBuildOutcome["status"], "drained">;

/** The causes a runner may report; anything else is a malformed outcome. */
const DELIVERY_FAILURE_CAUSES: ReadonlySet<string> = new Set<
  Extract<CorpusProjectionOfflineDeliveryOutcome, { type: "failed" }>["cause"]
>(["indexer", "infrastructure"]);

const validateDeliveryOutcome = (
  outcome: CorpusProjectionOfflineDeliveryOutcome,
): CorpusProjectionOfflineDeliveryOutcome => {
  const instant = (value: unknown) =>
    value instanceof Date && Number.isFinite(value.getTime());
  switch (outcome.type) {
    case "ingested":
    case "killed_at_deadline":
      return instant(outcome.startedAt) &&
        instant(outcome.endedAt) &&
        (outcome.exitCode === null || Number.isSafeInteger(outcome.exitCode))
        ? outcome
        : panic(`Offline delivery outcome is malformed: ${outcome.type}`);
    case "failed":
      return instant(outcome.startedAt) &&
        instant(outcome.endedAt) &&
        Number.isSafeInteger(outcome.exitCode) &&
        DELIVERY_FAILURE_CAUSES.has(outcome.cause)
        ? outcome
        : panic("Offline delivery outcome is malformed: failed");
    case "deadline_passed":
      return instant(outcome.refusedAt)
        ? outcome
        : panic("Offline delivery outcome is malformed: deadline_passed");
    default:
      outcome satisfies never;
      return panic(`Unhandled offline delivery outcome: ${String(outcome)}`);
  }
};

/**
 * Delivery slots. A slot runs one delivery and its record at a time; the
 * first failure of any slot ends the run once every slot has settled, so a
 * rejected run never leaves a delivery it started unattended.
 */
class SlotPool {
  readonly #free: number[];
  /** Each running slot's settlement, which never rejects. */
  readonly #running = new Map<number, Promise<void>>();
  /**
   * The first slot whose work rejected. Awaiting it raises that same
   * failure again; nothing else is thrown.
   */
  #failed: Promise<void> | null = null;

  constructor(slots: number) {
    this.#free = Array.from({ length: slots }, (_, slot) => slot);
  }

  async acquire(): Promise<number> {
    await this.raiseFailure();
    while (this.#free.length === 0) {
      await Promise.race(this.#running.values());
      await this.raiseFailure();
    }
    return this.#free.shift() ?? panic("No free offline delivery slot");
  }

  release(slot: number): void {
    this.#free.push(slot);
    this.#free.sort((left, right) => left - right);
  }

  run(slot: number, work: () => Promise<void>): void {
    const running = (async () => {
      try {
        await work();
      } finally {
        this.#running.delete(slot);
        this.release(slot);
      }
    })();
    // The pool observes every slot, so a failure waits for `raiseFailure`
    // rather than surfacing as an unhandled rejection.
    const settled = (async () => {
      const outcome = await Result.tryPromise({
        try: async () => await running,
        catch: (cause: unknown) => cause,
      });
      if (outcome.isErr()) {
        this.#failed ??= running;
      }
    })();
    this.#running.set(slot, settled);
  }

  async drain(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  /** Raise the first slot failure, if any, with its own error. */
  async raiseFailure(): Promise<void> {
    if (this.#failed !== null) {
      await this.#failed;
    }
  }
}

class OfflineRouteBuild<Family extends CorpusFamily> {
  readonly #options: CorpusProjectionOfflineBuildOptions<Family>;
  readonly #manifest: CorpusIndexManifest;
  #plan: CorpusProjectionOfflinePlan;
  readonly #hold: CorpusProjectionOfflineBuildLockHold;
  readonly #progress: CorpusProjectionOfflineBuildProgress;
  readonly #pending = new Map<ProjectionRevision, PendingProof>();
  /**
   * Built blocks waiting for a shard of their class, in reservation order.
   * A page is reserved only while this is empty, and the next shards serve
   * what it holds, so it holds at most one page: one shard's bytes.
   */
  #waiting: CarriedBlock[] = [];
  /** The current pass reached the end of the queue. */
  #passExhausted = false;
  /**
   * The current pass started at the head of the queue. Only such a pass
   * reading nothing proves the route drained; a first pass resumed from a
   * cursor is always followed by one from the head.
   */
  #passFromHead: boolean;
  #passReserved = 0;
  #passStarted = 0;
  #stop: Stop | null = null;
  #shardsSinceSweep = 0;
  /** Bytes and count of every block built so far: the page size's guide. */
  #builtBytes = 0;
  #builtBlocks = 0;
  /**
   * Kill deadlines of deliveries handed to the caller and not yet resolved.
   * A run that fails keeps its lock until the latest of them has passed.
   */
  readonly #inFlight = new Map<string, Date>();
  /** Shards the indexer ingested to their end: what judges a lone kill. */
  readonly #ingested: CorpusProjectionOfflineIngestedShard[] = [];
  /**
   * Final files of started shards not yet removed: one never delivered, or
   * whose delivery failed, is removed when the run ends.
   */
  readonly #shardFiles = new Set<string>();
  /** The proof pass in flight, if any; the next one waits for it. */
  #proving: Promise<void> = Promise.resolve();

  constructor(
    options: CorpusProjectionOfflineBuildOptions<Family>,
    plan: CorpusProjectionOfflinePlan,
    hold: CorpusProjectionOfflineBuildLockHold,
    progress: CorpusProjectionOfflineBuildProgress,
  ) {
    this.#options = options;
    this.#manifest = requireCorpusIndexManifest(
      options.family,
      options.generation,
    );
    this.#plan = plan;
    this.#hold = hold;
    this.#progress = progress;
    this.#passFromHead = progress.cursor === null;
  }

  /** The run's clock: wall time, or the test database's. */
  async #nowMs(): Promise<number> {
    const { testing } = this.#options;
    return testing === undefined
      ? Temporal.Now.instant().epochMilliseconds
      : (await testing.clock()).getTime();
  }

  /**
   * The instant a statement records in a database test; production leaves it
   * to PostgreSQL. Read before the transaction opens.
   */
  async #testNow(): Promise<Date | undefined> {
    const { testing } = this.#options;
    return testing === undefined ? undefined : await testing.clock();
  }

  /** The database clock, for comparisons with instants the database wrote. */
  async #databaseNowMs(): Promise<number> {
    const testNow = await this.#testNow();
    if (testNow !== undefined) {
      return testNow.getTime();
    }
    const [row] = await this.#options.runInTransaction(
      async (tx) =>
        await tx
          .select({ now: sql<Date | string>`clock_timestamp()` })
          .from(sql`(SELECT 1) AS clock`),
    );
    return new Date(
      row?.now ?? panic("The database returned no clock"),
    ).getTime();
  }

  async #sleep(milliseconds: number): Promise<void> {
    const { testing } = this.#options;
    await (testing === undefined
      ? sleep(milliseconds)
      : testing.sleep(milliseconds));
  }

  #report(): void {
    this.#progress.awaitingProof = this.#pending.size;
    this.#options.onProgress?.(this.#progress);
  }

  async #admit<Value>(
    unit: CorpusProjectionOfflineWorkUnit,
    work: () => Promise<Value>,
  ): Promise<Value> {
    return await this.#options.admit(unit, work);
  }

  async run(): Promise<CorpusProjectionOfflineBuildOutcome["status"]> {
    let returned = false;
    try {
      const status = await this.#runPasses();
      returned = true;
      return status;
    } finally {
      if (!returned) {
        // A delivery the caller never resolved may still run its indexer:
        // keep the route, and with it every slot's identity, until it has
        // certainly ended.
        await this.#outliveDeliveries();
      }
      // Every indexer that could read a file of this run has ended now.
      await Promise.all(
        [...this.#shardFiles].map(
          async (file) => await rm(file, { force: true }),
        ),
      );
      this.#shardFiles.clear();
    }
  }

  async #runPasses(): Promise<CorpusProjectionOfflineBuildOutcome["status"]> {
    if (!(await this.#generationIsBuilding())) {
      return "generation_not_building";
    }
    await this.#outlivePreviousIndexers();
    await this.#recover();
    const stopReservingAtMs = corpusProjectionOfflineStopReservingAtMs(
      this.#plan,
      this.#options.deadline.getTime(),
    );
    const slots = new SlotPool(this.#plan.slots);
    try {
      while (this.#stop === null) {
        if (this.#passExhausted && this.#waiting.length === 0) {
          // db-await-in-loop: a pass ends once: its deliveries and proofs settle before the next pass
          const next = await this.#endPass(slots, stopReservingAtMs);
          if (next === "drained") {
            break;
          }
          continue;
        }
        const slot = await slots.acquire();
        // db-await-in-loop: one shard per pass: proofs due before more work is reserved, batched per census
        await this.#proveDue();
        // db-await-in-loop: one stop check per shard; it sweeps only every few shards
        const stop = await this.#stopBeforeShard(stopReservingAtMs);
        if (stop !== null) {
          this.#stop = stop;
          slots.release(slot);
          break;
        }
        const started = await this.#produceShard(slot, stopReservingAtMs);
        if (started === null) {
          slots.release(slot);
          continue;
        }
        // A slot that failed while this shard was produced ends the run: the
        // shard is not delivered, and its started rows are left to the sweep.
        await slots.raiseFailure();
        slots.run(slot, async () => await this.#deliverAndRecord(started));
      }
    } finally {
      await slots.drain();
    }
    await slots.raiseFailure();
    await this.#releaseWaiting();
    await this.#drainProofs();
    this.#report();
    return this.#stop ?? "drained";
  }

  /**
   * A pass from the head reserved nothing. If any revision of the route is
   * still started or committed and undecided, by any actor, sweep and prove
   * once. `stuck` when that settled nothing.
   */
  async #settleOutstanding(): Promise<
    "nothing_outstanding" | "settled_some" | "stuck"
  > {
    if (!(await this.#outstandingExists())) {
      this.#progress.outstanding = 0;
      return "nothing_outstanding";
    }
    const before = this.#progress.recovered;
    await this.#recover();
    return this.#progress.recovered === before ? "stuck" : "settled_some";
  }

  /** The route's revisions started or committed and not decided yet. */
  #outstandingWhere() {
    const { family, generation, indexId } = this.#options;
    return and(
      eq(corpusIndexProjectionIntents.family, family),
      eq(corpusIndexProjectionIntents.generation, generation),
      eq(corpusIndexProjectionIntents.indexId, indexId),
      inArray(corpusIndexProjectionIntents.status, [
        "append_started",
        "append_committed",
      ]),
    );
  }

  /** Whether any revision of the route is outstanding: one probe. */
  async #outstandingExists(): Promise<boolean> {
    const [row] = await this.#options.runInTransaction(
      async (tx) =>
        await tx
          .select({
            outstanding: sql<boolean>`exists (${tx
              .select({ id: corpusIndexProjectionIntents.id })
              .from(corpusIndexProjectionIntents)
              .where(this.#outstandingWhere())})`,
          })
          .from(sql`(SELECT 1) AS probe`),
    );
    return row?.outstanding ?? false;
  }

  /** How many revisions of the route are outstanding, for the report. */
  async #countOutstanding(): Promise<number> {
    const [row] = await this.#options.runInTransaction(
      async (tx) =>
        await tx
          .select({ count: count() })
          .from(corpusIndexProjectionIntents)
          .where(this.#outstandingWhere()),
    );
    return row?.count ?? 0;
  }

  /**
   * The earliest instant, on the database clock and after `nowMs`, at which
   * an outstanding revision of the route certainly becomes decidable: a
   * start once its lease has ended (the sweep then moves it), an offline
   * commit once its barrier has passed and its indexer has certainly ended,
   * an ingest commit at its proof deadline. Null when none lies ahead.
   */
  async #nextDecidableAtMs(nowMs: number): Promise<number | null> {
    const t = corpusIndexProjectionIntents;
    const endedAfter = sql.raw(String(this.#plan.endedAfterMs));
    const publishDelay = sql.raw(
      String(corpusIndexAppendPublishDelayMs(this.#manifest)),
    );
    const decidableAt = sql<string>`(CASE
      WHEN ${t.status} = 'append_started' THEN ${t.leaseExpiresAt}
      WHEN ${t.appendDelivery} = 'offline_indexer' THEN greatest(
        ${t.appendPublishBarrierAt},
        ${t.appendStartedAt} + ${endedAfter} * interval '1 millisecond'
      )
      ELSE ${t.appendPublishBarrierAt} + ${publishDelay} * interval '1 millisecond'
    END)`;
    const after = new Date(nowMs).toISOString();
    const [row] = await this.#options.runInTransaction(
      async (tx) =>
        await tx
          .select({ at: sql<string | null>`min(${decidableAt})::text` })
          .from(t)
          .where(
            and(
              this.#outstandingWhere(),
              sql`${decidableAt} > ${after}::timestamptz`,
            ),
          ),
    );
    const at = row?.at ?? null;
    return at === null ? null : new Date(at).getTime();
  }

  /**
   * End a pass: settle its deliveries and proofs, so its withdrawals are
   * runnable again, then decide whether another pass from the head is due.
   */
  async #endPass(
    slots: SlotPool,
    stopReservingAtMs: number,
  ): Promise<"drained" | "next"> {
    await slots.drain();
    await slots.raiseFailure();
    await this.#drainProofs();
    const walk = this.#progress.walk;
    walk.lastPassReserved = this.#passReserved;
    walk.lastPassStarted = this.#passStarted;
    if (this.#stop !== null) {
      return "drained";
    }
    if ((await this.#nowMs()) >= stopReservingAtMs) {
      this.#stop = "deadline_reached";
      return "drained";
    }
    if (this.#passReserved === 0 && this.#passFromHead) {
      // Nothing was runnable; a retry due soon is still this run's to take.
      const dueInMs = await this.#nextRetryDueInMs();
      if (dueInMs === null) {
        // Drained only with nothing of the route outstanding. What recovery
        // settles may be runnable again (a withdrawal is), so the walk goes
        // on from the head after it, and ends drained only when a pass from
        // the head finds nothing and nothing is outstanding.
        const settled = await this.#settleOutstanding();
        if (settled === "nothing_outstanding") {
          return "drained";
        }
        if (settled === "stuck") {
          // Nothing is decidable now. Wait for the first row that becomes
          // decidable while the run still reserves, then sweep, prove and
          // walk again; otherwise the caller runs the build again later.
          const nowMs = await this.#databaseNowMs();
          const decidableAtMs = await this.#nextDecidableAtMs(nowMs);
          if (decidableAtMs === null || decidableAtMs >= stopReservingAtMs) {
            this.#progress.outstanding = await this.#countOutstanding();
            this.#stop = "awaiting_proof";
            return "drained";
          }
          await this.#sleep(decidableAtMs - nowMs + 1);
        }
      } else {
        await this.#sleep(dueInMs);
      }
    } else if (this.#passReserved > 0 && this.#passStarted === 0) {
      this.#stop = "no_progress";
      return "drained";
    }
    if (walk.passes >= CORPUS_PROJECTION_OFFLINE_MAX_WALK_PASSES) {
      this.#stop = "walk_pass_limit";
      return "drained";
    }
    walk.passes += 1;
    this.#passExhausted = false;
    this.#passFromHead = true;
    this.#passReserved = 0;
    this.#passStarted = 0;
    this.#progress.cursor = null;
    this.#report();
    return "next";
  }

  /**
   * How long until the route's earliest batchable entity whose retry is
   * scheduled becomes runnable, if that is within the longest append retry;
   * null when none is.
   */
  async #nextRetryDueInMs(): Promise<number | null> {
    const { runInTransaction, family, generation, indexId } = this.#options;
    const nowMs = await this.#databaseNowMs();
    const [row] = await runInTransaction(
      async (tx) =>
        await tx
          .select({
            dueAt: min(corpusIndexProjectionStates.retryNotBefore),
          })
          .from(corpusIndexProjectionStates)
          .where(
            and(
              eq(corpusIndexProjectionStates.family, family),
              eq(corpusIndexProjectionStates.generation, generation),
              eq(corpusIndexProjectionStates.desiredIndexId, indexId),
              eq(corpusIndexProjectionStates.workStatus, "retry_scheduled"),
              eq(corpusIndexProjectionStates.appendMode, "batchable"),
              gt(corpusIndexProjectionStates.retryNotBefore, new Date(nowMs)),
            ),
          ),
    );
    const dueAt = row?.dueAt ?? null;
    if (dueAt === null) {
      return null;
    }
    const dueInMs = new Date(dueAt).getTime() - nowMs;
    return dueInMs <= CORPUS_PROJECTION_APPEND_RETRY_CAP_MS
      ? Math.max(0, dueInMs) + 1
      : null;
  }

  async #stopBeforeShard(stopReservingAtMs: number): Promise<Stop | null> {
    if ((await this.#nowMs()) >= stopReservingAtMs) {
      return "deadline_reached";
    }
    if (!(await this.#hold.stillHeld())) {
      return "lock_lost";
    }
    if (!(await this.#generationIsBuilding())) {
      return "generation_not_building";
    }
    if (this.#shardsSinceSweep >= SWEEP_EVERY_SHARDS) {
      this.#shardsSinceSweep = 0;
      await this.#sweep();
    }
    return null;
  }

  /** The first slices build only a generation nobody reads yet. */
  async #generationIsBuilding(): Promise<boolean> {
    const { family, generation, runInTransaction } = this.#options;
    const rows = await runInTransaction(
      async (tx) =>
        await tx
          .select({ status: corpusIndexGenerations.status })
          .from(corpusIndexGenerations)
          .where(
            and(
              eq(corpusIndexGenerations.family, family),
              eq(corpusIndexGenerations.generation, generation),
            ),
          )
          .limit(1),
    );
    return rows.at(0)?.status === "building";
  }

  /**
   * Wait until every offline run an earlier holder of this route started has
   * certainly ended, by the database clock: its indexer identities are this
   * run's slots, and a holder that died left its indexers running until their
   * kill deadlines. Every such deadline is at most the latest offline start
   * on the route plus the kill budget.
   */
  async #outlivePreviousIndexers(): Promise<void> {
    const { runInTransaction, family, generation, indexId } = this.#options;
    const nowMs = await this.#databaseNowMs();
    const [row] = await runInTransaction(
      async (tx) =>
        await tx
          .select({
            latestStart: max(corpusIndexProjectionIntents.appendStartedAt),
          })
          .from(corpusIndexProjectionIntents)
          .where(
            and(
              eq(corpusIndexProjectionIntents.family, family),
              eq(corpusIndexProjectionIntents.generation, generation),
              eq(corpusIndexProjectionIntents.indexId, indexId),
              // One probe of the route's offline start index: the latest
              // start decides, however old; one long ended waits nothing.
              eq(
                corpusIndexProjectionIntents.appendDelivery,
                "offline_indexer",
              ),
            ),
          ),
    );
    const latestStart = row?.latestStart ?? null;
    if (latestStart === null) {
      return;
    }
    const endedAtMs = corpusProjectionOfflineIndexerEndedAt(
      new Date(latestStart),
      this.#manifest,
    ).getTime();
    if (endedAtMs > nowMs) {
      await this.#sleep(endedAtMs - nowMs);
    }
  }

  /** Keep the route until every unresolved delivery has certainly ended. */
  async #outliveDeliveries(): Promise<void> {
    let latestMs: number | null = null;
    for (const killDeadline of this.#inFlight.values()) {
      latestMs = Math.max(latestMs ?? 0, killDeadline.getTime());
    }
    if (latestMs === null) {
      return;
    }
    const endedAtMs =
      latestMs + CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS;
    const nowMs = await this.#databaseNowMs();
    if (endedAtMs > nowMs) {
      await this.#sleep(endedAtMs - nowMs);
    }
  }

  /**
   * Converge what an earlier run left: expired leases are swept (an offline
   * start becomes committed behind its certain end, any other expired start
   * goes to cleanup), and committed revisions of the route are proven. The
   * coordinator does the same; doing it here makes a crashed run converge
   * even where no coordinator runs this generation.
   */
  async #recover(): Promise<void> {
    await this.#sweep();
    const { runInTransaction, client, family, generation, indexId } =
      this.#options;
    for (let pass = 0; pass < RECOVERY_PROOF_MAX_PASSES; pass += 1) {
      const testNow = await this.#testNow();
      const cycle = await this.#admit(
        { phase: "recover", revisions: CORPUS_PROJECTION_DELETE_MAX_REVISIONS },
        async () =>
          await executeCorpusProjectionProofCycle({
            runInTransaction,
            client,
            family,
            generation,
            // One route holds one index, so there is nothing to rotate over.
            scope: { type: "route", indexId },
            afterIndexId: null,
            testNow,
          }),
      );
      if (cycle.status !== "proved") {
        if (cycle.status === "census_failed") {
          this.#progress.censusFailures += 1;
        }
        return;
      }
      this.#progress.recovered +=
        cycle.applied +
        cycle.retired +
        cycle.withdrawn +
        cycle.staleCleanupPending +
        cycle.blocked;
      if (cycle.waiting === cycle.claimed) {
        return;
      }
    }
  }

  async #sweep(): Promise<void> {
    const { runInTransaction, family, generation } = this.#options;
    for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
      const testNow = await this.#testNow();
      const recovered = await this.#admit(
        { phase: "recover", revisions: CORPUS_PROJECTION_DELETE_MAX_REVISIONS },
        async () =>
          await runInTransaction(
            async (tx) =>
              await recoverExpiredCorpusProjectionIntentsTx(tx, {
                family,
                generation,
                limit: CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
                ...(testNow === undefined ? {} : { testNow }),
              }),
          ),
      );
      this.#progress.recovered += recovered.length;
      if (recovered.length < CORPUS_PROJECTION_DELETE_MAX_REVISIONS) {
        return;
      }
    }
  }

  /**
   * Reserve, build and start one shard and write its file. Returns null when
   * nothing started. Reservation stops at the run's stop point, when the
   * shard is closed, or when the pass is at the end of the queue.
   */
  async #produceShard(
    slot: number,
    stopReservingAtMs: number,
  ): Promise<StartedShard | null> {
    const shardId = this.#options.testing?.newShardId?.() ?? Bun.randomUUIDv7();
    const name = corpusProjectionOfflineShardName(this.#options.runId, shardId);
    const staging = await openCorpusProjectionShardStaging(
      this.#options.shardDirectory,
      name,
    );
    let started: StartedShard | null = null;
    try {
      started = await this.#fillAndStart(staging, {
        slot,
        name,
        requestId: shardId,
        stopReservingAtMs,
      });
      if (started !== null) {
        this.#shardFiles.add(started.shard.path);
      }
      return started;
    } finally {
      // Nothing started, or the shard failed: its staging file goes.
      if (started === null) {
        await staging.discard();
      }
    }
  }

  async #fillAndStart(
    staging: CorpusProjectionShardStaging,
    {
      slot,
      name,
      requestId,
      stopReservingAtMs,
    }: {
      slot: number;
      name: string;
      /** The shard's identity, which its offline request carries. */
      requestId: string;
      stopReservingAtMs: number;
    },
  ): Promise<StartedShard | null> {
    const shardClass = corpusProjectionOfflineNextShardClass(
      this.#plan,
      this.#waiting.map((block) => block.shardClass),
    );
    const entries = await this.#fill(staging, shardClass, stopReservingAtMs);
    if (entries.length === 0) {
      return null;
    }
    const started = await this.#start(entries, { shardClass, requestId });
    if (started === null) {
      return null;
    }
    const file = await staging.finish(
      started.entries.map(({ range }) => range),
    );
    const shard: StartedShardFile = {
      name,
      path: file.path,
      indexId: this.#options.indexId,
      slot,
      killDeadline: corpusProjectionOfflineIndexerKillDeadline(
        started.startedAt,
        this.#manifest,
      ),
      revisionCount: started.entries.length,
      documentCount: started.entries.reduce(
        (sum, { documentCount }) => sum + documentCount,
        0,
      ),
      bytes: file.bytes,
    };
    return {
      shard,
      entries: started.entries,
      startedAt: started.startedAt,
      shardClass,
    };
  }

  /**
   * Fill a shard of one class: from waiting blocks of that class first, then,
   * for the largest class only, from newly reserved pages. A block of another
   * class waits for a shard of its own; a capped class never reserves, so its
   * file may be small, and that is the point: it holds only what failed
   * together before.
   */
  async #fill(
    staging: CorpusProjectionShardStaging,
    shardClass: number,
    stopReservingAtMs: number,
  ): Promise<ShardEntry[]> {
    const entries: ShardEntry[] = [];
    let earliestLeaseExpiresAtMs: number | null = null;
    const fill = () => ({
      revisions: entries.length,
      bytes: staging.bytes(),
      limit: shardClass,
      earliestLeaseExpiresAtMs,
    });
    /** Place the blocks of this class that fit; return every other one. */
    const placeAll = async (
      blocks: readonly CarriedBlock[],
    ): Promise<CarriedBlock[]> => {
      const left: CarriedBlock[] = [];
      for (const block of blocks) {
        if (
          !corpusProjectionOfflineBlockJoins(this.#plan, fill(), {
            shardClass: block.shardClass,
            bytes: block.bytes,
          })
        ) {
          left.push(block);
          continue;
        }
        const range = await staging.append(block.block);
        entries.push({
          lease: block.lease,
          documentCount: block.documentCount,
          range,
        });
        const expiresAtMs = block.lease.leaseExpiresAt.getTime();
        earliestLeaseExpiresAtMs =
          earliestLeaseExpiresAtMs === null
            ? expiresAtMs
            : Math.min(earliestLeaseExpiresAtMs, expiresAtMs);
      }
      return left;
    };
    this.#waiting = await placeAll(this.#waiting);
    if (shardClass < this.#plan.shardRevisionCap) {
      return entries;
    }
    // A page is reserved only while nothing waits: a block this shard cannot
    // take (another class, or too large for the bytes left) closes the shard,
    // and the next one serves it. So the wait holds at most one page.
    while (
      !this.#passExhausted &&
      this.#stop === null &&
      this.#waiting.length === 0
    ) {
      const nowMs = await this.#nowMs();
      if (
        nowMs >= stopReservingAtMs ||
        corpusProjectionOfflineShardIsClosed(this.#plan, fill(), nowMs)
      ) {
        return entries;
      }
      const limit = corpusProjectionOfflinePageLimit(this.#plan, {
        remainingRevisions: shardClass - entries.length,
        averageBlockBytes:
          this.#builtBlocks === 0
            ? null
            : Math.ceil(this.#builtBytes / this.#builtBlocks),
      });
      // db-await-in-loop: a page walk: one reservation page of a bounded size per pass
      const built = await this.#reserveAndBuildPage(limit);
      this.#waiting.push(...(await placeAll(built)));
      this.#progress.waitingPeak = Math.max(
        this.#progress.waitingPeak,
        this.#waiting.length,
      );
    }
    return entries;
  }

  /**
   * Reserve one page, read its material, and build its blocks. Every
   * reservation that cannot be built is settled here, in one transaction per
   * kind; the built blocks come back in reservation order. Blocks past one
   * shard's bytes are not kept: their reservations are handed back, so a
   * page never holds more than one shard in memory.
   */
  async #reserveAndBuildPage(limit: number): Promise<CarriedBlock[]> {
    const { runInTransaction, family, generation, indexId, policy } =
      this.#options;
    const testNow = await this.#testNow();
    const reserved = await this.#admit(
      { phase: "reserve", revisions: limit },
      async () => {
        const page = await runInTransaction(
          async (tx) =>
            await reserveCorpusProjectionRoutePageTx(tx, {
              family,
              generation,
              indexId,
              after: this.#progress.cursor,
              limit,
              leaseMs: this.#plan.leaseMs,
              ...(testNow === undefined ? {} : { testNow }),
            }),
        );
        if (
          page.type === "generation_not_building" ||
          page.leases.length === 0
        ) {
          return {
            page,
            materials: { ready: [], rejected: [] },
            caps: new Map<ProjectionRevision, number>(),
            singles: new Set<string>(),
          };
        }
        return {
          page,
          ...(await runInTransaction(async (tx) => ({
            materials: await readReservedCorpusProjectionMaterialsTx(tx, {
              leases: page.leases,
            }),
            // Stable while the leases are held: only a withdrawal of the
            // entity's own outstanding revision could lower them.
            caps: await readCorpusProjectionOfflineRequestCapsTx(
              tx,
              page.leases,
            ),
            singles: await readSingleDeliveryEntitiesTx(tx, page.leases),
          }))),
        };
      },
    );
    const { page, materials, caps, singles } = reserved;
    if (page.type === "generation_not_building") {
      this.#stop = "generation_not_building";
      return [];
    }
    this.#progress.cursor = page.cursor;
    this.#progress.reserved += page.leases.length;
    this.#passReserved += page.leases.length;
    if (page.exhausted) {
      this.#passExhausted = true;
    }
    const rejected = await settleRejectedCorpusProjectionMaterials({
      runInTransaction,
      rejected: materials.rejected,
      policy,
      testNow: await this.#testNow(),
    });
    this.#progress.notStarted.cancelled += rejected.cancelled;
    this.#progress.notStarted.leaseLost += rejected.leaseLost;
    this.#progress.notStarted.retryScheduled += rejected.retryScheduled;
    this.#progress.notStarted.blocked += rejected.blocked;

    const payloadReader =
      this.#options.testing?.payloadReader ?? loadCorpusProjectionPayload;
    const blocks: CarriedBlock[] = [];
    const overflow: CorpusProjectionIntentLease[] = [];
    const failures: CorpusProjectionReservationFailureOfLease[] = [];
    let pageBytes = 0;
    for await (const { material, built } of streamWithConcurrency({
      items: materials.ready,
      limit: this.#plan.payloadReadConcurrency,
      lookAhead: this.#plan.payloadReadConcurrency,
      operation: async (ready) => ({
        material: ready,
        built: await loadCorpusProjectionRevisionBlock({
          runInTransaction,
          material: ready,
          recordBuildMs: () => undefined,
          payloadReader,
        }),
      }),
    })) {
      if (built.isErr()) {
        failures.push(
          corpusProjectionRevisionBuildFailure(
            material.lease,
            built.error,
            policy,
          ),
        );
        continue;
      }
      // The file holds the block as one line per document.
      const block = `${built.value.parts.join("\n")}\n`;
      const bytes = Buffer.byteLength(block, "utf-8");
      this.#builtBytes += bytes;
      this.#builtBlocks += 1;
      if (blocks.length > 0 && pageBytes + bytes > this.#plan.shardByteCap) {
        overflow.push(material.lease);
        continue;
      }
      pageBytes += bytes;
      blocks.push({
        lease: material.lease,
        documentCount: built.value.documentCount,
        block,
        bytes,
        // A revision whose entity delivers alone starts in a request of
        // its own, whatever its cap.
        shardClass:
          material.lease.appendMode === "single" ||
          singles.has(material.lease.entityId)
            ? 1
            : corpusProjectionOfflineShardClass(
                this.#plan,
                caps.get(material.lease.intentId) ??
                  panic(
                    `Reserved revision has no request cap: ${material.lease.intentId}`,
                  ),
              ),
      });
    }
    const classified = await classifyCorpusProjectionReservationFailures({
      runInTransaction,
      failures,
      testNow: await this.#testNow(),
    });
    this.#progress.notStarted.retryScheduled += classified.retryScheduled;
    this.#progress.notStarted.blocked += classified.blocked;
    this.#progress.notStarted.cancelled += classified.staleCancelled;
    this.#progress.notStarted.leaseLost += classified.leaseLost;
    await this.#handBack(overflow, {
      counter: "handedBack",
      message: "offline projection page held more than one shard of bytes",
    });
    return blocks;
  }

  /**
   * Start a shard's revisions offline as one request, the file's. The request
   * is admitted once, and its transactions of at most one store batch run one
   * after another inside that admission, so the governor never holds the
   * request's later transactions past its start window. A delivery failure
   * then halves exactly what was delivered together. The shard holds one
   * class, so the request is within every revision's cap.
   *
   * - A lease that no longer covers the run once admitted is handed back
   *   before the request is planned, so the plan counts only what can start.
   * - The request's kill deadline counts from its first start. A transaction
   *   past the start window, or a lease that would end before that run and
   *   its record, starts nothing; those leases are handed back, and so is
   *   every later chunk once the window has closed. A later pass takes them.
   * - The file is written afterwards with exactly the revisions that
   *   started.
   */
  async #start(
    entries: readonly ShardEntry[],
    { shardClass, requestId }: { shardClass: number; requestId: string },
  ): Promise<{ entries: ShardEntry[]; startedAt: Date } | null> {
    const { runInTransaction } = this.#options;
    if (entries.length > shardClass) {
      return panic("An offline shard holds more revisions than its class");
    }
    const attempt = await this.#admit(
      { phase: "start", revisions: entries.length },
      async () => {
        const nowMs = await this.#nowMs();
        const startable = entries.filter(({ lease }) =>
          corpusProjectionOfflineLeaseCanStart(
            this.#plan,
            lease.leaseExpiresAt.getTime(),
            nowMs,
          ),
        );
        const expired = entries.filter((entry) => !startable.includes(entry));
        const started: ShardEntry[] = [];
        const handBack: ShardEntry[] = [];
        let requestStartedAt: Date | null = null;
        if (startable.length === 0) {
          return { expired, started, handBack, requestStartedAt };
        }
        const request: CorpusProjectionOfflineRequest = {
          requestId,
          plannedRevisionCount: startable.length,
        };
        let windowClosed = false;
        for (const chunk of chunkItems(
          startable,
          CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
        )) {
          if (windowClosed) {
            handBack.push(...chunk);
            continue;
          }
          const testNow = await this.#testNow();
          const result = await runInTransaction(async (tx) => {
            await requireFreshReadCommittedStartTx(tx);
            return await startCorpusProjectionOfflineRequestChunkTx(tx, {
              request,
              leases: chunk.map(({ lease, documentCount }) => ({
                lease,
                expectedDocumentCount: documentCount,
              })),
              testNow,
            });
          });
          requestStartedAt ??= result.requestStartedAt;
          const outcomeOf = new Map<
            ProjectionRevision,
            CorpusProjectionOfflineStart
          >(result.outcomes.map((outcome) => [outcome.intentId, outcome]));
          for (const entry of chunk) {
            const outcome = outcomeOf.get(entry.lease.intentId);
            switch (outcome?.status) {
              case "started":
                started.push(entry);
                break;
              case "stale_cancelled":
                this.#progress.notStarted.cancelled += 1;
                break;
              case "lease_lost":
              case undefined:
                this.#progress.notStarted.leaseLost += 1;
                break;
              case "not_started":
                handBack.push(entry);
                windowClosed ||= outcome.reason === "start_window_closed";
                break;
              default:
                outcome satisfies never;
                return panic(`Unhandled offline start: ${String(outcome)}`);
            }
          }
        }
        return { expired, started, handBack, requestStartedAt };
      },
    );
    await this.#handBack(
      attempt.expired.map(({ lease }) => lease),
      {
        counter: "handedBack",
        message:
          "projection reservation no longer covers an offline run before its start",
      },
    );
    await this.#handBack(
      attempt.handBack.map(({ lease }) => lease),
      {
        counter: "handedBack",
        message:
          "offline request did not start this revision in its start window",
      },
    );
    this.#progress.started += attempt.started.length;
    this.#passStarted += attempt.started.length;
    if (attempt.requestStartedAt === null || attempt.started.length === 0) {
      return null;
    }
    return { entries: attempt.started, startedAt: attempt.requestStartedAt };
  }

  /**
   * Cancel reservations the run will not start, one statement per store
   * batch. Their entities keep their place in the queue, so a later pass
   * reserves them again.
   */
  async #handBack(
    leases: readonly CorpusProjectionIntentLease[],
    {
      counter,
      message,
    }: { counter: "cancelled" | "handedBack"; message: string },
  ): Promise<void> {
    if (leases.length === 0) {
      return;
    }
    const cancelled = await cancelCorpusProjectionReservations({
      runInTransaction: this.#options.runInTransaction,
      leases,
      errorMessage: message,
      testNow: await this.#testNow(),
    });
    this.#progress.notStarted[counter] += cancelled.cancelled;
    this.#progress.notStarted.leaseLost += cancelled.leaseLost;
  }

  /**
   * Whether every revision of a delivered shard is in the index exactly
   * (`exact`), some is not (`short`), or the census could not answer
   * (`census_failed`). Only decides what a failure costs; the proof decides
   * each revision.
   */
  async #censusShard(
    entries: readonly ShardEntry[],
  ): Promise<"exact" | "short" | "census_failed"> {
    for (const batch of chunkItems(
      [...entries],
      CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
    )) {
      const census = await proveCorpusProjectionRevisionsPresent({
        client: this.#options.client,
        indexId: this.#options.indexId,
        expected: batch.map(({ lease, documentCount }) => ({
          revision: lease.intentId,
          documentCount,
        })),
      });
      if (census.isErr()) {
        this.#progress.censusFailures += 1;
        return "census_failed";
      }
      if (census.value.unproven.length > 0) {
        return "short";
      }
    }
    return "exact";
  }

  /**
   * Deliver a started shard and record every started revision with the count
   * its start stored, whatever the delivery reported: a strict rejection can
   * exit zero, and a killed run may have published whole splits. The census
   * decides each revision; the delivery decides what a failure costs, stored
   * with the record. A run that lost its lock does not deliver, since another
   * process may hold the slot's indexer identity, and neither does one whose
   * generation is no longer building, or whose kill budget is already spent:
   * it still records, as `none`, and the census then finds nothing and
   * withdraws, uncharged.
   */
  async #deliverAndRecord(started: StartedShard): Promise<void> {
    const { shard } = started;
    const shards = this.#progress.shards;
    if (started.shardClass < this.#plan.shardRevisionCap) {
      shards.capped += 1;
    }
    const handoff = await this.#handoff(started);
    let fault: CorpusIndexAppendFault = "none";
    if (handoff.type === "deliver") {
      this.#inFlight.set(shard.name, shard.killDeadline);
      const outcome = validateDeliveryOutcome(
        await this.#options.deliver(handoff.shard),
      );
      this.#inFlight.delete(shard.name);
      shards.delivered += 1;
      fault = await this.#classify(started, outcome, handoff.shard.killAfterMs);
    } else {
      shards.infrastructureFailures += 1;
      this.#stop ??= handoff.stop;
    }
    await this.#record(started, fault);
    await rm(shard.path, { force: true });
    this.#shardFiles.delete(shard.path);
    this.#shardsSinceSweep += 1;
    await this.#proveDue();
    this.#report();
  }

  /**
   * Whether a started shard may reach the indexer now, and with how long a
   * kill budget: the lock still held, the generation still building, and
   * budget left on the database clock read right before the hand-off.
   */
  async #handoff(
    started: StartedShard,
  ): Promise<
    | { type: "deliver"; shard: CorpusProjectionOfflineShard }
    | { type: "withheld"; stop: Stop }
  > {
    if (!(await this.#hold.stillHeld())) {
      return { type: "withheld", stop: "lock_lost" };
    }
    if (!(await this.#generationIsBuilding())) {
      return { type: "withheld", stop: "generation_not_building" };
    }
    // Whatever the clock query took counts against the budget, so the time
    // between its reading and the hand-off never extends the indexer's run.
    const askedAtMs = await this.#nowMs();
    const databaseNowMs = await this.#databaseNowMs();
    const queryMs = Math.max(0, (await this.#nowMs()) - askedAtMs);
    const killAfterMs =
      started.shard.killDeadline.getTime() - databaseNowMs - queryMs;
    if (killAfterMs <= 0) {
      return { type: "withheld", stop: "infrastructure_failed" };
    }
    return { type: "deliver", shard: { ...started.shard, killAfterMs } };
  }

  async #classify(
    { shard, entries }: StartedShard,
    outcome: CorpusProjectionOfflineDeliveryOutcome,
    /** The budget the indexer was handed, after staging and hand-off. */
    killAfterMs: number,
  ): Promise<CorpusIndexAppendFault> {
    const shards = this.#progress.shards;
    const ranMs =
      outcome.type === "deadline_passed"
        ? 0
        : Math.max(0, outcome.endedAt.getTime() - outcome.startedAt.getTime());
    const attempted = () => {
      shards.attemptedBytes += shard.bytes;
      shards.attemptedMs += ranMs;
    };
    switch (outcome.type) {
      case "ingested":
        attempted();
        shards.ingested += 1;
        this.#ingested.push({ bytes: shard.bytes, ms: ranMs });
        return "documents";
      case "killed_at_deadline": {
        attempted();
        const census = await this.#censusShard(entries);
        if (census === "exact") {
          shards.mergeOverruns += 1;
          return "documents";
        }
        if (census === "census_failed") {
          shards.infrastructureFailures += 1;
          this.#stop ??= "infrastructure_failed";
          return "none";
        }
        if (entries.length === 1) {
          const judgement = corpusProjectionOfflineLoneKillJudgement(
            this.#plan,
            { ingested: this.#ingested, bytes: shard.bytes, killAfterMs },
          );
          switch (judgement) {
            case "revision":
              shards.killedAlone += 1;
              return "documents";
            case "budget_short":
              shards.infrastructureFailures += 1;
              this.#stop ??= "infrastructure_failed";
              return "none";
            case "rate_too_slow":
              shards.infrastructureFailures += 1;
              this.#stop ??= "rate_too_slow";
              return "none";
            default:
              judgement satisfies never;
              return panic(`Unhandled lone kill: ${String(judgement)}`);
          }
        }
        shards.killedTooLarge += 1;
        const next = corpusProjectionOfflineShardCapAfterKill(
          this.#plan.shardByteCap,
          shard.bytes,
        );
        if (next.type === "rate_too_slow") {
          this.#stop ??= "rate_too_slow";
        } else {
          this.#plan = { ...this.#plan, shardByteCap: next.shardByteCap };
          shards.shardByteCap = next.shardByteCap;
        }
        return "killed";
      }
      case "failed":
        attempted();
        if (outcome.cause === "indexer") {
          shards.indexerFailures += 1;
          return "documents";
        }
        shards.infrastructureFailures += 1;
        this.#stop ??= "infrastructure_failed";
        return "none";
      case "deadline_passed":
        shards.infrastructureFailures += 1;
        this.#stop ??= "infrastructure_failed";
        return "none";
      default:
        outcome satisfies never;
        return panic(`Unhandled offline delivery: ${String(outcome)}`);
    }
  }

  async #record(
    { entries, startedAt }: StartedShard,
    fault: CorpusIndexAppendFault,
  ): Promise<void> {
    const requestSize = entries.length;
    const { runInTransaction } = this.#options;
    // Each revision's proof waits for the end counted from its own start, and
    // the request's transactions all began within the start window of the
    // first: waiting that much longer covers every one of them.
    const endedAtMs =
      corpusProjectionOfflineIndexerEndedAt(
        startedAt,
        this.#manifest,
      ).getTime() + CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS;
    for (const chunk of chunkItems(
      [...entries],
      CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
    )) {
      const testNow = await this.#testNow();
      const recorded = await this.#admit(
        { phase: "record", revisions: chunk.length },
        async () =>
          await runInTransaction(
            async (tx) =>
              await recordAcceptedCorpusProjectionAppendsTx(tx, {
                accepted: chunk.map(({ lease, documentCount }) => ({
                  intentId: lease.intentId,
                  leaseToken: lease.leaseToken,
                  documentCount,
                })),
                delivery: { type: "offline_indexer", fault },
                testNow,
              }),
          ),
      );
      const nowMs = await this.#nowMs();
      for (const { status, intentId } of recorded) {
        switch (status) {
          case "accepted":
            this.#progress.recorded += 1;
            this.#pending.set(intentId, {
              notBeforeMs: nowMs,
              endedAtMs,
              requestSize,
              fault,
            });
            break;
          case "stale_cleanup_pending":
            this.#progress.recorded += 1;
            this.#progress.sentToCleanup += 1;
            break;
          case "lease_lost":
            // The sweep or an erasure moved it first; a census still decides
            // it if the sweep committed it (as `none`), so it stays this
            // run's to prove.
            this.#pending.set(intentId, {
              notBeforeMs: nowMs,
              endedAtMs,
              requestSize,
              fault: "none",
            });
            break;
          default:
            status satisfies never;
            return panic(`Unhandled offline record: ${String(status)}`);
        }
      }
    }
  }

  /**
   * Prove every recorded revision that is due, one census per batch. A
   * revision a census could not decide yet is censused again once its
   * indexer has certainly ended; one whose census failed, after the retry
   * delay. Passes run one at a time, so slots that finish together never
   * census one revision twice and count it twice.
   */
  async #proveDue(): Promise<void> {
    const pass = this.#proving.then(async () => await this.#provePass());
    this.#proving = pass.then(
      () => undefined,
      () => undefined,
    );
    await pass;
  }

  async #provePass(): Promise<void> {
    const { runInTransaction, client, family, generation, indexId } =
      this.#options;
    const nowMs = await this.#nowMs();
    const due = [...this.#pending]
      .filter(([, pending]) => pending.notBeforeMs <= nowMs)
      .map(([revision]) => revision);
    for (const batch of chunkItems(
      due,
      CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
    )) {
      const testNow = await this.#testNow();
      const proof = await this.#admit(
        { phase: "prove", revisions: batch.length },
        async () =>
          await proveCorpusProjectionRevisions({
            runInTransaction,
            client,
            family,
            generation,
            indexId,
            revisions: batch,
            testNow,
          }),
      );
      const afterMs = await this.#nowMs();
      this.#settleProof(proof, afterMs);
    }
  }

  #settleProof(
    proof: Awaited<ReturnType<typeof proveCorpusProjectionRevisions>>,
    nowMs: number,
  ): void {
    const progress = this.#progress;
    const retryAt = nowMs + CORPUS_PROJECTION_APPEND_RETRY_BASE_MS;
    for (const revision of proof.settled) {
      this.#pending.delete(revision);
      progress.superseded += 1;
    }
    for (const revision of [...proof.unpublished, ...proof.censusFailed]) {
      const pending = this.#pending.get(revision);
      if (pending !== undefined) {
        pending.notBeforeMs = retryAt;
      }
    }
    if (proof.censusError !== null) {
      progress.censusFailures += 1;
    }
    for (const outcome of proof.outcomes) {
      const pending = this.#pending.get(outcome.intentId);
      switch (outcome.status) {
        case "applied":
          progress.proved += 1;
          break;
        case "withdrawn":
          progress.withdrawn += 1;
          break;
        case "unproven_cleanup_pending":
          progress.sentToCleanup += 1;
          // Retired from a shared request its indexer ran to a verdict, the
          // entity goes to single requests, which only the per-row path
          // sends; a kill or a failure outside the documents keeps it batched.
          if (
            pending !== undefined &&
            pending.requestSize > 1 &&
            pending.fault === "documents"
          ) {
            progress.perRowHandoffs += 1;
          }
          break;
        case "stale_cleanup_pending":
          progress.sentToCleanup += 1;
          break;
        case "blocked":
          progress.blockedByProof += 1;
          break;
        case "already_applied":
        case "not_accepted":
          progress.superseded += 1;
          break;
        case "awaiting_publication":
          // An inexact count is final only once the indexer has ended.
          if (pending !== undefined) {
            pending.notBeforeMs = Math.max(pending.endedAtMs, retryAt);
          }
          continue;
        default:
          outcome satisfies never;
          panic(`Unhandled offline proof: ${String(outcome)}`);
      }
      this.#pending.delete(outcome.intentId);
    }
  }

  /**
   * Cancel the reservations of built blocks no shard took, so the per-row
   * path, or the next run, can take their entities at once instead of after
   * their leases.
   */
  async #releaseWaiting(): Promise<void> {
    const carried = this.#waiting;
    this.#waiting = [];
    await this.#handBack(
      carried.map(({ lease }) => lease),
      {
        counter: "cancelled",
        message: "offline projection build stopped before this revision",
      },
    );
  }

  /**
   * Prove what is still pending until it is decided or the run's deadline
   * passes; what is left converges through any later proof.
   */
  async #drainProofs(): Promise<void> {
    const deadlineMs = this.#options.deadline.getTime();
    while (this.#pending.size > 0) {
      // db-await-in-loop: waits for the next revision to become decidable, then one batched proof pass
      await this.#proveDue();
      this.#report();
      if (this.#pending.size === 0) {
        return;
      }
      const nowMs = await this.#nowMs();
      let nextMs = Number.POSITIVE_INFINITY;
      for (const { notBeforeMs } of this.#pending.values()) {
        nextMs = Math.min(nextMs, notBeforeMs);
      }
      if (nextMs >= deadlineMs || nowMs >= deadlineMs) {
        return;
      }
      await this.#sleep(Math.max(0, nextMs - nowMs));
    }
  }
}

/**
 * Run an offline build of one route until a pass over its queue finds
 * nothing to do, its deadline, a lost lock, or a delivery that failed outside
 * its documents. The only export a runner needs; see the module comment for
 * the protocol and the caller's obligations.
 */
export const buildCorpusProjectionRouteOffline = async <
  Family extends CorpusFamily,
>(
  options: CorpusProjectionOfflineBuildOptions<Family>,
): Promise<CorpusProjectionOfflineBuildOutcome> => {
  const { family, generation, indexId, lock, resumeAfter } = options;
  const manifest = requireCorpusIndexManifest(family, generation);
  requireCorpusIndexIdForManifest(manifest, indexId);
  validateCorpusProjectionOfflineRunId(options.runId);
  validateCorpusProjectionPayloadPolicy(options.policy);
  const plan = planCorpusProjectionOfflineBuild(manifest, options.policy);
  if (!Number.isFinite(options.deadline.getTime())) {
    return panic("Offline projection build deadline is not an instant");
  }
  const progress = emptyProgress(resumeAfter, plan.shardByteCap);
  const hold = await lock.tryAcquire(lockKeyOf(family, generation, indexId));
  if (hold === null) {
    return { status: "lock_held", progress };
  }
  try {
    const status = await new OfflineRouteBuild(
      options,
      plan,
      hold,
      progress,
    ).run();
    return { status, progress };
  } finally {
    await hold.release();
  }
};
