import { panic } from "better-result";

import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS } from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
  corpusIndexCommitTimeoutSecs,
  corpusProjectionAppendIngestBudgetMs,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  CORPUS_PROJECTION_LEASE_MAX_MS,
  CORPUS_PROJECTION_LEASE_MIN_MS,
  CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
} from "@/api/lib/legal-search/corpus-index-projection-store";

/**
 * The deterministic half of an offline route build: how large a shard may
 * grow, how long its reservations last, when a shard must close, and when a
 * run must stop reserving. Everything here is a pure function of the
 * generation's manifest, the caller's policy and a clock reading, so the
 * properties over every registered manifest cover what a run will do.
 *
 * How the kill budget relates to shard size. An offline run is killed at its
 * request's first start plus the generation's ingest budget (its commit window
 * plus the upload allowance), the same budget an ingest request gets, so the
 * lease a start requires covers it. That budget is spent in this order:
 *
 * 1. the request's later start transactions, at most
 *    `CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS` (a request of at most
 *    `CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS` revisions takes at most
 *    sixteen transactions of `CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE` rows);
 * 2. indexing the file, at most `corpusProjectionOfflineIndexingWindowMs`:
 *    half of what the start window leaves, and never more than one commit
 *    window, so a run commits once and no revision straddles a commit;
 * 3. the other half: writing the file, the spawn, the merges at exit and the
 *    publish.
 *
 * A shard's bytes are therefore capped at what the measured rate indexes in
 * the indexing window, and at half the indexing heap so memory does not force
 * an early commit either. The cap must hold the largest revision the builder
 * emits (`CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES`), or the plan is
 * refused: every request, a lone revision included, fits its window.
 *
 * How the lease relates to the start. Every revision's lease must reach the
 * request's kill deadline plus the record margin, both counted from the first
 * start (`corpusProjectionOfflineRequestLeaseFloor`). So the first start must
 * come no later than the earliest lease's expiry less the kill budget and the
 * record margin: from reserving to the first start a shard has at most
 * `corpusProjectionOfflineReserveToStartMs`, the longest lease less both. The
 * fill window is that less the close allowance. With a 600 s commit window the
 * kill budget is 660 s, so a 900 s lease leaves 180 s between reserving and
 * the first start, and indexing gets 300 s. A build slower than that closes
 * its shard early, with fewer revisions; a lease is never started short, and
 * a start transaction past the start window starts nothing.
 */

/** A conservative indexing rate: half the per-core rate measured offline. */
export const CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND = 8_000_000;
export const CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES = 1024 ** 3;
/**
 * A shard file is one offline request, so it holds at most the most
 * revisions one request may; bytes are the bound that usually applies first.
 */
export const CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_REVISIONS =
  CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS;

const MIN_INGEST_BYTES_PER_SECOND = 1_000_000;
const MAX_INGEST_BYTES_PER_SECOND = 1_000_000_000;
/** A shard must hold the largest revision the builder emits. */
const MIN_SHARD_BYTES = CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES;
const MAX_SHARD_BYTES = 4 * 1024 ** 3;
const MAX_SHARD_REVISIONS = CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS;
const MIN_FILL_WINDOW_MS = 10_000;
const MAX_SLOTS = 8;
const MAX_PROOF_ALLOWANCE_MS = 30 * 60_000;
const MAX_CONSECUTIVE_DELIVERY_FAILURES = 10;

/** What a run may choose. Every field is validated against the manifest. */
export type CorpusProjectionOfflineBuildPolicy = {
  /** Deliveries in flight at once; each slot has its own indexer identity. */
  slots: number;
  /** Bytes the offline indexer indexes per second, as measured. */
  ingestBytesPerSecond: number;
  /** Upper bound on a shard's file; the derived cap may be lower. */
  maxShardBytes: number;
  maxShardRevisions: number;
  /**
   * How long a shard may spend reading and building before its first start:
   * the lease is the start margin plus this.
   */
  fillWindowMs: number;
  /**
   * Time from a shard's close to its first start, kept between the close
   * and its earliest lease's start margin. Later start transactions and the
   * file write happen after the first start and cost run time, not lease.
   */
  closeAllowanceMs: number;
  /** Time after the last indexer has certainly ended for its proof. */
  proofAllowanceMs: number;
  /** Deliveries in a row that did not ingest before the run stops. */
  maxConsecutiveDeliveryFailures: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
};

/** The policy resolved against one generation. */
export type CorpusProjectionOfflinePlan = {
  slots: number;
  /** An offline run is killed this long after its first start. */
  killBudgetMs: number;
  /** From a start until no write of its run can appear. */
  endedAfterMs: number;
  /**
   * A request's first start needs every lease in it to have at least this
   * left: the kill budget plus the record margin.
   */
  startMarginMs: number;
  leaseMs: number;
  /** A shard closes once its earliest lease has this little left. */
  closeMarginMs: number;
  /**
   * The longest a shard may take from its first reservation to its first
   * start: the fill window plus the close allowance, never more than
   * `corpusProjectionOfflineReserveToStartMs`.
   */
  reserveToFirstStartMs: number;
  /** Start transactions a full shard takes, all inside the start window. */
  startTransactionsPerShard: number;
  /** How long a full shard may take to index at the measured rate. */
  indexingWindowMs: number;
  shardByteCap: number;
  shardRevisionCap: number;
  /** A run reserves nothing once its deadline is this close. */
  stopReservingBeforeMs: number;
  maxConsecutiveDeliveryFailures: number;
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
};

const integerIn = (
  value: number,
  min: number,
  max: number,
  name: string,
): number =>
  Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : panic(
        `Offline projection build ${name} must be an integer from ${min} to ${max}`,
      );

/** The indexing heap the generation's indexes were created with. */
const indexingHeapBytes = (manifest: CorpusIndexManifest): number =>
  manifest.engine.indexConfig.indexing_settings.resources.heap_size;

/**
 * How long an offline run of `manifest` may spend indexing its file: of the
 * kill budget, what the start window leaves, halved so the file write, the
 * spawn, the merges at exit and the publish get the other half; and at most
 * one commit window. 300 s for a 600 s commit window, 30 s for a 60 s one.
 */
export const corpusProjectionOfflineIndexingWindowMs = (
  manifest: CorpusIndexManifest,
): number => {
  const afterStartsMs =
    corpusProjectionAppendIngestBudgetMs(manifest) -
    CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS;
  return afterStartsMs > 0
    ? Math.min(
        Math.floor(afterStartsMs / 2),
        corpusIndexCommitTimeoutSecs(manifest) * 1000,
      )
    : panic("The generation's kill budget leaves no time after the starts");
};

/**
 * The longest a shard of `manifest` may take from reserving to its request's
 * first start: every lease must still reach the kill deadline plus the record
 * margin from then (`corpusProjectionOfflineRequestLeaseFloor`), and no lease
 * is longer than `CORPUS_PROJECTION_LEASE_MAX_MS`. 180 s for a 600 s commit
 * window.
 */
export const corpusProjectionOfflineReserveToStartMs = (
  manifest: CorpusIndexManifest,
): number =>
  CORPUS_PROJECTION_LEASE_MAX_MS -
  corpusProjectionAppendIngestBudgetMs(manifest) -
  CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS;

/**
 * Bytes one shard may hold for `manifest`: indexing it at the measured rate
 * fits the indexing window, and it fits in half the indexing heap. Refused
 * when that cannot hold the largest revision, which would then be killed
 * before it is indexed however often it is retried.
 */
const corpusProjectionOfflineShardByteCap = (
  manifest: CorpusIndexManifest,
  { ingestBytesPerSecond, maxShardBytes }: CorpusProjectionOfflineBuildPolicy,
): number => {
  const cap = Math.min(
    maxShardBytes,
    Math.floor(indexingHeapBytes(manifest) / 2),
    Math.floor(
      (ingestBytesPerSecond *
        corpusProjectionOfflineIndexingWindowMs(manifest)) /
        1000,
    ),
  );
  return cap >= CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES
    ? cap
    : panic(
        "Offline projection build ingest rate cannot index the largest revision inside the generation's indexing window",
      );
};

export const planCorpusProjectionOfflineBuild = (
  manifest: CorpusIndexManifest,
  policy: CorpusProjectionOfflineBuildPolicy,
): CorpusProjectionOfflinePlan => {
  const slots = integerIn(policy.slots, 1, MAX_SLOTS, "slot count");
  integerIn(
    policy.ingestBytesPerSecond,
    MIN_INGEST_BYTES_PER_SECOND,
    MAX_INGEST_BYTES_PER_SECOND,
    "ingest rate",
  );
  integerIn(
    policy.maxShardBytes,
    MIN_SHARD_BYTES,
    MAX_SHARD_BYTES,
    "shard byte limit",
  );
  const shardRevisionCap = integerIn(
    policy.maxShardRevisions,
    1,
    MAX_SHARD_REVISIONS,
    "shard revision limit",
  );
  const killBudgetMs = corpusProjectionAppendIngestBudgetMs(manifest);
  const startMarginMs =
    killBudgetMs + CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS;
  const closeAllowanceMs = integerIn(
    policy.closeAllowanceMs,
    0,
    CORPUS_PROJECTION_LEASE_MAX_MS,
    "close allowance",
  );
  const closeMarginMs = startMarginMs + closeAllowanceMs;
  const maxFillWindowMs =
    corpusProjectionOfflineReserveToStartMs(manifest) - closeAllowanceMs;
  if (maxFillWindowMs < MIN_FILL_WINDOW_MS) {
    return panic(
      "The generation's kill budget leaves no fill window inside the longest projection lease",
    );
  }
  const fillWindowMs = integerIn(
    policy.fillWindowMs,
    MIN_FILL_WINDOW_MS,
    maxFillWindowMs,
    "fill window",
  );
  const leaseMs = closeMarginMs + fillWindowMs;
  if (
    leaseMs < CORPUS_PROJECTION_LEASE_MIN_MS ||
    leaseMs > CORPUS_PROJECTION_LEASE_MAX_MS
  ) {
    return panic("Offline projection build lease is out of range");
  }
  const proofAllowanceMs = integerIn(
    policy.proofAllowanceMs,
    0,
    MAX_PROOF_ALLOWANCE_MS,
    "proof allowance",
  );
  const endedAfterMs =
    killBudgetMs + CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS;
  return {
    slots,
    killBudgetMs,
    endedAfterMs,
    startMarginMs,
    leaseMs,
    closeMarginMs,
    reserveToFirstStartMs: fillWindowMs + closeAllowanceMs,
    startTransactionsPerShard: Math.ceil(
      shardRevisionCap / CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
    ),
    indexingWindowMs: corpusProjectionOfflineIndexingWindowMs(manifest),
    shardByteCap: corpusProjectionOfflineShardByteCap(manifest, policy),
    shardRevisionCap,
    // The last shard may fill for its whole window, close, run to its kill,
    // end, and still leave its proof the allowance before the deadline.
    stopReservingBeforeMs:
      fillWindowMs + closeAllowanceMs + endedAfterMs + proofAllowanceMs,
    maxConsecutiveDeliveryFailures: integerIn(
      policy.maxConsecutiveDeliveryFailures,
      1,
      MAX_CONSECUTIVE_DELIVERY_FAILURES,
      "consecutive delivery failure limit",
    ),
    payloadReadConcurrency: policy.payloadReadConcurrency,
    retryDelayMs: policy.retryDelayMs,
    payloadRetryLimit: policy.payloadRetryLimit,
  };
};

type ShardFill = {
  revisions: number;
  bytes: number;
  /** The shard's class: the most revisions it may hold. */
  limit: number;
  /** The earliest lease expiry among the shard's revisions, or null if empty. */
  earliestLeaseExpiresAtMs: number | null;
};

/**
 * Whether a shard takes no more revisions: it is at a cap, or its earliest
 * lease is so close to its start margin that only the starts and the file
 * write still fit. An empty shard is never closed.
 */
export const corpusProjectionOfflineShardIsClosed = (
  plan: CorpusProjectionOfflinePlan,
  fill: ShardFill,
  nowMs: number,
): boolean =>
  fill.revisions > 0 &&
  (fill.revisions >= Math.min(fill.limit, plan.shardRevisionCap) ||
    fill.bytes >= plan.shardByteCap ||
    (fill.earliestLeaseExpiresAtMs !== null &&
      fill.earliestLeaseExpiresAtMs - nowMs <= plan.closeMarginMs));

/**
 * Whether one more block of `blockBytes` still fits a shard. Every block the
 * builder emits fits an empty shard, since the plan's byte cap holds the
 * largest revision; one that does not is refused, never sent alone past the
 * indexing window.
 */
export const corpusProjectionOfflineBlockFits = (
  plan: CorpusProjectionOfflinePlan,
  fill: ShardFill,
  blockBytes: number,
): boolean => {
  if (blockBytes > plan.shardByteCap) {
    return panic(
      `An offline projection block of ${blockBytes} bytes exceeds the shard byte cap`,
    );
  }
  return (
    fill.revisions < Math.min(fill.limit, plan.shardRevisionCap) &&
    fill.bytes + blockBytes <= plan.shardByteCap
  );
};

/**
 * Whether a built block joins a shard: it is of the shard's class (its
 * `limit`) and still fits. A block of another class waits for its own.
 */
export const corpusProjectionOfflineBlockJoins = (
  plan: CorpusProjectionOfflinePlan,
  fill: ShardFill,
  block: { shardClass: number; bytes: number },
): boolean =>
  block.shardClass === fill.limit &&
  corpusProjectionOfflineBlockFits(plan, fill, block.bytes);

/** Whether a reservation can still start, with its run's kill inside its lease. */
export const corpusProjectionOfflineLeaseCanStart = (
  plan: CorpusProjectionOfflinePlan,
  leaseExpiresAtMs: number,
  nowMs: number,
): boolean => leaseExpiresAtMs - nowMs >= plan.startMarginMs;

/** The instant from which a run with this deadline reserves nothing. */
export const corpusProjectionOfflineStopReservingAtMs = (
  plan: CorpusProjectionOfflinePlan,
  deadlineMs: number,
): number => deadlineMs - plan.stopReservingBeforeMs;

/**
 * The class of a revision whose offline request cap is `cap`
 * (`readCorpusProjectionOfflineRequestCapsTx`): the cap, bounded by the run's
 * shard size. A shard file is started as one request, so it holds revisions
 * of one class only and at most that many. Revisions that never failed share
 * the largest class; a revision a failed delivery left capped travels only
 * with revisions capped alike, so an empty delivery halves exactly what
 * failed together and drags no revision that never failed into small files.
 * A class of one is a revision alone in its file: its next empty delivery is
 * charged to it, and nothing else is charged with it.
 */
export const corpusProjectionOfflineShardClass = (
  plan: CorpusProjectionOfflinePlan,
  cap: number,
): number =>
  Number.isSafeInteger(cap) && cap >= 1
    ? Math.min(cap, plan.shardRevisionCap)
    : panic(`Offline request cap is not a positive integer: ${cap}`);

/**
 * The class the next shard serves: the smallest class any built block is
 * waiting in, so capped revisions go first and their leases do not run out
 * behind full shards; otherwise the largest class, filled from new
 * reservations. Capped revisions only come from failed deliveries and each
 * failure halves their class, so they cannot hold uncapped work back for
 * longer than they take to drain.
 */
export const corpusProjectionOfflineNextShardClass = (
  plan: CorpusProjectionOfflinePlan,
  waitingClasses: Iterable<number>,
): number => {
  let next = plan.shardRevisionCap;
  for (const waiting of waitingClasses) {
    next = Math.min(next, waiting);
  }
  return next;
};

const SHARD_NAME_PART = /^[A-Za-z0-9._-]+$/u;
/** The engine's job contract bounds a shard name. */
const SHARD_NAME_MAX_LENGTH = 200;
const RUN_ID_MAX_LENGTH = 64;

export const validateCorpusProjectionOfflineRunId = (runId: string): string =>
  runId.length >= 1 &&
  runId.length <= RUN_ID_MAX_LENGTH &&
  SHARD_NAME_PART.test(runId) &&
  !runId.startsWith(".")
    ? runId
    : panic(
        `Offline projection build run id must be 1 to ${RUN_ID_MAX_LENGTH} of [A-Za-z0-9._-], not starting with a dot`,
      );

/**
 * A shard's name, which is also the indexer's only identity for its file:
 * the engine skips a path it has finished, whatever the file holds now. The
 * fresh id makes every name unique across runs even if a run id repeats.
 */
export const corpusProjectionOfflineShardName = (
  runId: string,
  shardId: string,
): string => {
  const name = `${validateCorpusProjectionOfflineRunId(runId)}.${shardId}`;
  return name.length <= SHARD_NAME_MAX_LENGTH && SHARD_NAME_PART.test(shardId)
    ? name
    : panic("Offline projection shard name is invalid");
};
