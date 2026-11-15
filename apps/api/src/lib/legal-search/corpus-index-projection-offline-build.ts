import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { rm } from "node:fs/promises";

import { streamWithConcurrency } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { sleep } from "@stll/concurrency/sleep";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusProjectionReservationQueueKey } from "@/api/lib/db/aggregate-lock";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  requireCorpusIndexIdForManifest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { recoverExpiredCorpusProjectionIntentsTx } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { CORPUS_PROJECTION_DELETE_MAX_REVISIONS } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { readReservedCorpusProjectionMaterialsTx } from "@/api/lib/legal-search/corpus-index-projection-materials";
import {
  corpusProjectionOfflineBlockJoins,
  type CorpusProjectionOfflineBuildPolicy,
  corpusProjectionOfflineLeaseCanStart,
  corpusProjectionOfflineNextShardClass,
  type CorpusProjectionOfflinePlan,
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
 * The exit code and outcome a delivery reports change no transition. A strict
 * rejection may exit zero or not, and a revision can be partly visible, so
 * only the census decides, and an inexact count only once the run has
 * certainly ended (its kill deadline plus the end margin, by the database
 * clock). The outcome only stops a run whose deliveries keep failing.
 *
 * One shard file is one start request. An empty delivery cannot say which
 * revision, if any, was at fault, so a revision withdrawn from a request of
 * several stays batched, uncharged, and may start again only in a request of
 * at most half that size (`readCorpusProjectionOfflineRequestCapsTx`); alone,
 * it is charged like any isolated document fault and blocks at the attempt
 * limit. Files are therefore grouped by request cap
 * (`corpusProjectionOfflineShardClass`), so a delivery failure halves exactly
 * what failed together. A retired revision that shared its request leaves its
 * entity in single requests, which the per-row path sends; the batch never
 * reserves such an entity and the progress counts it as handed over. One that
 * switched to single delivery after the batch reserved it is started in a
 * request of its own.
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
   * The delivery slot, from 0. At most one delivery per slot is in flight, so
   * an indexer identity derived from the index and the slot is never used by
   * two processes at once while the run holds its lock.
   */
  slot: number;
  /**
   * The instant, on the database clock, by which the indexer must have been
   * killed. The caller enforces it outside this process, so neither this
   * process nor its death can extend it, and refuses a delivery that reaches
   * the indexer after it.
   */
  killDeadline: Date;
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
  | { type: "failed"; exitCode: number; startedAt: Date; endedAt: Date }
  | {
      type: "killed_at_deadline";
      exitCode: number | null;
      startedAt: Date;
      endedAt: Date;
    }
  /** The indexer refused the shard: its kill deadline had already passed. */
  | { type: "deadline_passed"; refusedAt: Date };

/**
 * Deliver one shard through the offline indexer and resolve once it has
 * exited, been killed, or been refused. A rejection is the end of the run: an
 * indexer it started may still be running under the slot's identity, so the
 * caller must not start another run in the same process.
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
 * The caller's session-level advisory lock. One run per route holds it, so
 * no two processes ever deliver under one indexer identity.
 */
export type CorpusProjectionOfflineBuildLock = {
  tryAcquire: (key: {
    domain: string;
    name: string;
  }) => Promise<CorpusProjectionOfflineBuildLockHold | null>;
};

/** One unit of database work the caller's load governor admits. */
export type CorpusProjectionOfflineWorkUnit = {
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
  /** A previous run's `progress.cursor`, or null to walk from the head. */
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
  /** Where a later run may resume the reservation walk. */
  cursor: CorpusProjectionReservationQueueKey | null;
  reserved: number;
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
     * Handed back unstarted by a request's start: its start window had
     * closed, or the lease would end before the request's run and record.
     */
    handedBack: number;
  };
  started: number;
  shards: {
    delivered: number;
    ingested: number;
    failed: number;
    killedAtDeadline: number;
    deadlinePassed: number;
    /** Shards started but not delivered, as the run lost its lock. */
    undelivered: number;
    /** Files of revisions an earlier empty delivery capped. */
    capped: number;
    /** Bytes and indexer time of ingested shards: the measured rate. */
    ingestedBytes: number;
    ingestedMs: number;
  };
  recorded: number;
  /** Applied by this run's proof. */
  proved: number;
  /**
   * Absent once the indexer had certainly ended; no delete owed. The entity
   * is reserved again, by this run or a later one, in a request of at most
   * half the one it was withdrawn from.
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
  censusFailures: number;
  /**
   * Rows of earlier runs this run settled: expired leases its sweep
   * recovered and committed revisions its recovery proof decided.
   */
  recovered: number;
};

export type CorpusProjectionOfflineBuildOutcome = {
  status:
    | "drained"
    | "deadline_reached"
    | "lock_held"
    | "lock_lost"
    | "generation_not_building"
    | "delivery_failing";
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
 * no advisory and no transaction id lock means nothing was locked yet.
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
): CorpusProjectionOfflineBuildProgress => ({
  cursor,
  reserved: 0,
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
    failed: 0,
    killedAtDeadline: 0,
    deadlinePassed: 0,
    undelivered: 0,
    capped: 0,
    ingestedBytes: 0,
    ingestedMs: 0,
  },
  recorded: 0,
  proved: 0,
  withdrawn: 0,
  sentToCleanup: 0,
  perRowHandoffs: 0,
  blockedByProof: 0,
  superseded: 0,
  awaitingProof: 0,
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
  /** `corpusProjectionOfflineShardClass` of its request cap. */
  shardClass: number;
};

type StartedShard = {
  shard: CorpusProjectionOfflineShard;
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
  /** Revisions its start request held; a retirement from more isolates it. */
  requestSize: number;
};

type Stop = Exclude<CorpusProjectionOfflineBuildOutcome["status"], "drained">;

const validateDeliveryOutcome = (
  outcome: CorpusProjectionOfflineDeliveryOutcome,
): CorpusProjectionOfflineDeliveryOutcome => {
  const instant = (value: unknown) =>
    value instanceof Date && Number.isFinite(value.getTime());
  switch (outcome.type) {
    case "ingested":
    case "failed":
    case "killed_at_deadline":
      return instant(outcome.startedAt) &&
        instant(outcome.endedAt) &&
        (outcome.exitCode === null || Number.isSafeInteger(outcome.exitCode))
        ? outcome
        : panic(`Offline delivery outcome is malformed: ${outcome.type}`);
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
  readonly #running = new Map<number, Promise<void>>();
  #failure: { error: unknown } | null = null;

  constructor(slots: number) {
    this.#free = Array.from({ length: slots }, (_, slot) => slot);
  }

  async acquire(): Promise<number> {
    this.rethrow();
    while (this.#free.length === 0) {
      await Promise.race(this.#running.values());
      this.rethrow();
    }
    return this.#free.shift() ?? panic("No free offline delivery slot");
  }

  release(slot: number): void {
    this.#free.push(slot);
    this.#free.sort((left, right) => left - right);
  }

  run(slot: number, work: () => Promise<void>): void {
    const running = (async () => {
      const outcome = await Result.tryPromise({
        try: work,
        catch: (cause: unknown) => cause,
      });
      if (outcome.isErr()) {
        this.#failure ??= { error: outcome.error };
      }
      this.#running.delete(slot);
      this.release(slot);
    })();
    this.#running.set(slot, running);
  }

  async drain(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  rethrow(): void {
    if (this.#failure !== null) {
      throw this.#failure.error;
    }
  }
}

class OfflineRouteBuild<Family extends CorpusFamily> {
  readonly #options: CorpusProjectionOfflineBuildOptions<Family>;
  readonly #plan: CorpusProjectionOfflinePlan;
  readonly #hold: CorpusProjectionOfflineBuildLockHold;
  readonly #progress: CorpusProjectionOfflineBuildProgress;
  readonly #pending = new Map<ProjectionRevision, PendingProof>();
  /**
   * Built blocks waiting for a shard of their class, in reservation order.
   * Capped classes are served before any page is reserved again, so this
   * holds at most what one full shard's pages brought besides it.
   */
  #waiting: CarriedBlock[] = [];
  #exhausted = false;
  #stop: Stop | null = null;
  #consecutiveFailures = 0;
  #shardsSinceSweep = 0;
  /** The proof pass in flight, if any; the next one waits for it. */
  #proving: Promise<void> = Promise.resolve();

  constructor(
    options: CorpusProjectionOfflineBuildOptions<Family>,
    plan: CorpusProjectionOfflinePlan,
    hold: CorpusProjectionOfflineBuildLockHold,
    progress: CorpusProjectionOfflineBuildProgress,
  ) {
    this.#options = options;
    this.#plan = plan;
    this.#hold = hold;
    this.#progress = progress;
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
    if (!(await this.#generationIsBuilding())) {
      return "generation_not_building";
    }
    await this.#recover();
    const slots = new SlotPool(this.#plan.slots);
    const stopReservingAtMs = corpusProjectionOfflineStopReservingAtMs(
      this.#plan,
      this.#options.deadline.getTime(),
    );
    try {
      while (
        this.#stop === null &&
        (!this.#exhausted || this.#waiting.length > 0)
      ) {
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
        slots.run(slot, async () => await this.#deliverAndRecord(started));
      }
    } finally {
      await slots.drain();
    }
    slots.rethrow();
    await this.#releaseWaiting();
    await this.#drainProofs();
    this.#report();
    return this.#stop ?? "drained";
  }

  async #stopBeforeShard(stopReservingAtMs: number): Promise<Stop | null> {
    if ((await this.#nowMs()) >= stopReservingAtMs) {
      return "deadline_reached";
    }
    if (
      this.#consecutiveFailures >= this.#plan.maxConsecutiveDeliveryFailures
    ) {
      return "delivery_failing";
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
   * shard is closed, or when the walk is at its end.
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
    const outcome = await Result.tryPromise({
      try: async () =>
        await this.#fillAndStart(staging, {
          slot,
          name,
          requestId: shardId,
          stopReservingAtMs,
        }),
      catch: (cause: unknown) => cause,
    });
    if (outcome.isErr()) {
      await staging.discard();
      throw outcome.error;
    }
    if (outcome.value === null) {
      await staging.discard();
    }
    return outcome.value;
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
    const shard: CorpusProjectionOfflineShard = {
      name,
      path: file.path,
      indexId: this.#options.indexId,
      slot,
      killDeadline: corpusProjectionOfflineIndexerKillDeadline(
        started.startedAt,
        requireCorpusIndexManifest(
          this.#options.family,
          this.#options.generation,
        ),
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
            bytes: Buffer.byteLength(block.block, "utf-8"),
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
    while (!this.#exhausted) {
      const nowMs = await this.#nowMs();
      if (
        nowMs >= stopReservingAtMs ||
        corpusProjectionOfflineShardIsClosed(this.#plan, fill(), nowMs)
      ) {
        return entries;
      }
      const limit = Math.min(
        CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
        shardClass - entries.length,
      );
      // db-await-in-loop: a page walk: one reservation page of up to an append's revisions per pass
      const built = await this.#reserveAndBuildPage(limit);
      this.#waiting.push(...(await placeAll(built)));
    }
    return entries;
  }

  /**
   * Reserve one page, read its material, and build its blocks. Every
   * reservation that cannot be built is settled here, in one transaction per
   * kind; the built blocks come back in reservation order.
   */
  async #reserveAndBuildPage(limit: number): Promise<CarriedBlock[]> {
    const { runInTransaction, family, generation, indexId, policy } =
      this.#options;
    const testNow = await this.#testNow();
    const { page, materials, caps, singles } = await this.#admit(
      { phase: "reserve", revisions: limit },
      async () => {
        const reserved = await runInTransaction(
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
        if (reserved.leases.length === 0) {
          return {
            page: reserved,
            materials: { ready: [], rejected: [] },
            caps: new Map<ProjectionRevision, number>(),
            singles: new Set<string>(),
          };
        }
        return {
          page: reserved,
          ...(await runInTransaction(async (tx) => ({
            materials: await readReservedCorpusProjectionMaterialsTx(tx, {
              leases: reserved.leases,
            }),
            // Stable while the leases are held: only a withdrawal of the
            // entity's own outstanding revision could lower them.
            caps: await readCorpusProjectionOfflineRequestCapsTx(
              tx,
              reserved.leases,
            ),
            singles: await readSingleDeliveryEntitiesTx(tx, reserved.leases),
          }))),
        };
      },
    );
    this.#progress.cursor = page.cursor;
    this.#progress.reserved += page.leases.length;
    if (page.exhausted) {
      this.#exhausted = true;
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
    const failures: CorpusProjectionReservationFailureOfLease[] = [];
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
      if (built.isOk()) {
        // The file holds the block as one line per document.
        blocks.push({
          lease: material.lease,
          documentCount: built.value.documentCount,
          block: `${built.value.parts.join("\n")}\n`,
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
      } else {
        failures.push(
          corpusProjectionRevisionBuildFailure(
            material.lease,
            built.error,
            policy,
          ),
        );
      }
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
    return blocks;
  }

  /**
   * Start a shard's revisions offline as one request, the file's, in
   * transactions of at most one append's leases, one after another. A
   * delivery failure then halves exactly what was delivered together. The
   * shard holds one class, so the request is within every revision's cap.
   *
   * - A lease that no longer covers the run from now is cancelled before the
   *   request is planned, so the plan counts only what can start.
   * - The request's kill deadline counts from its first start. A transaction
   *   past the start window, or a lease that would end before that run and
   *   its record, starts nothing; those leases are handed back, and so is
   *   every later chunk once the window has closed.
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
    const nowMs = await this.#nowMs();
    const startable = entries.filter(({ lease }) =>
      corpusProjectionOfflineLeaseCanStart(
        this.#plan,
        lease.leaseExpiresAt.getTime(),
        nowMs,
      ),
    );
    await this.#handBack(
      entries.filter((entry) => !startable.includes(entry)),
      "cancelled",
    );
    if (startable.length === 0) {
      return null;
    }
    const request: CorpusProjectionOfflineRequest = {
      requestId,
      plannedRevisionCount: startable.length,
    };
    const started: ShardEntry[] = [];
    const handBack: ShardEntry[] = [];
    let requestStartedAt: Date | null = null;
    let windowClosed = false;
    for (const chunk of chunkItems(
      startable,
      CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
    )) {
      if (windowClosed) {
        handBack.push(...chunk);
        continue;
      }
      const result = await this.#admit(
        { phase: "start", revisions: chunk.length },
        async () => {
          // Read after the admission: a governor that held the transaction
          // back has spent start window, and the store judges it so.
          const testNow = await this.#testNow();
          return await runInTransaction(async (tx) => {
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
        },
      );
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
    await this.#handBack(handBack, "handedBack");
    this.#progress.started += started.length;
    if (requestStartedAt === null || started.length === 0) {
      return null;
    }
    return { entries: started, startedAt: requestStartedAt };
  }

  /** Cancel reservations a shard will not start, so their entities requeue. */
  async #handBack(
    entries: readonly ShardEntry[],
    counter: "cancelled" | "handedBack",
  ): Promise<void> {
    const cancelled = await cancelCorpusProjectionReservations({
      runInTransaction: this.#options.runInTransaction,
      leases: entries.map(({ lease }) => lease),
      errorMessage:
        counter === "cancelled"
          ? "projection reservation no longer covers an offline run before its start"
          : "offline request did not start this revision in its start window",
      testNow: await this.#testNow(),
    });
    this.#progress.notStarted[counter] += cancelled.cancelled;
    this.#progress.notStarted.leaseLost += cancelled.leaseLost;
  }

  /**
   * Deliver a started shard and record every started revision with the count
   * its start stored, whatever the delivery reported: a strict rejection can
   * exit zero, and a killed run may have published whole splits. The census
   * decides each revision. A run that lost its lock does not deliver, since
   * another process may hold the slot's indexer identity; it still records,
   * and the census then finds nothing and withdraws.
   */
  async #deliverAndRecord(started: StartedShard): Promise<void> {
    const { shard } = started;
    const shards = this.#progress.shards;
    if (started.shardClass < this.#plan.shardRevisionCap) {
      shards.capped += 1;
    }
    if (await this.#hold.stillHeld()) {
      const outcome = validateDeliveryOutcome(
        await this.#options.deliver(shard),
      );
      shards.delivered += 1;
      switch (outcome.type) {
        case "ingested":
          shards.ingested += 1;
          shards.ingestedBytes += shard.bytes;
          shards.ingestedMs += Math.max(
            0,
            outcome.endedAt.getTime() - outcome.startedAt.getTime(),
          );
          this.#consecutiveFailures = 0;
          break;
        case "failed":
          shards.failed += 1;
          this.#consecutiveFailures += 1;
          break;
        case "killed_at_deadline":
          shards.killedAtDeadline += 1;
          this.#consecutiveFailures += 1;
          break;
        case "deadline_passed":
          shards.deadlinePassed += 1;
          this.#consecutiveFailures += 1;
          break;
        default:
          outcome satisfies never;
          return panic(`Unhandled offline delivery: ${String(outcome)}`);
      }
    } else {
      shards.undelivered += 1;
      this.#stop ??= "lock_lost";
    }
    await this.#record(started);
    await rm(shard.path, { force: true });
    this.#shardsSinceSweep += 1;
    await this.#proveDue();
    this.#report();
  }

  async #record({ entries, startedAt }: StartedShard): Promise<void> {
    const requestSize = entries.length;
    const { runInTransaction, family, generation } = this.#options;
    // Each revision's proof waits for the end counted from its own start, and
    // the request's transactions all began within the start window of the
    // first: waiting that much longer covers every one of them.
    const endedAtMs =
      corpusProjectionOfflineIndexerEndedAt(
        startedAt,
        requireCorpusIndexManifest(family, generation),
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
            });
            break;
          case "stale_cleanup_pending":
            this.#progress.recorded += 1;
            this.#progress.sentToCleanup += 1;
            break;
          case "lease_lost":
            // The sweep or an erasure moved it first; a census still decides
            // it if the sweep committed it, so it stays this run's to prove.
            this.#pending.set(intentId, {
              notBeforeMs: nowMs,
              endedAtMs,
              requestSize,
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
          // Retired from a shared request, the entity goes to single
          // requests, which only the per-row path sends.
          if ((pending?.requestSize ?? 1) > 1) {
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
   * path can take their entities at once instead of after their leases.
   */
  async #releaseWaiting(): Promise<void> {
    const carried = this.#waiting;
    this.#waiting = [];
    const cancelled = await cancelCorpusProjectionReservations({
      runInTransaction: this.#options.runInTransaction,
      leases: carried.map(({ lease }) => lease),
      errorMessage: "offline projection build stopped before this revision",
      testNow: await this.#testNow(),
    });
    this.#progress.notStarted.cancelled += cancelled.cancelled;
    this.#progress.notStarted.leaseLost += cancelled.leaseLost;
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
 * Run an offline build of one route until it has drained the route's queue,
 * reached its deadline, lost its lock, or seen its deliveries keep failing.
 * The only export a runner needs; see the module comment for the protocol.
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
  const progress = emptyProgress(resumeAfter);
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
