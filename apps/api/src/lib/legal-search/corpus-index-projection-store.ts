import { panic } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { isUuid } from "@stll/uuid-codec";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  corpusProjectionReservationQueue,
  type CorpusProjectionReservationQueueKey,
  lockCorpusProjectionAcceptedRows,
  lockCorpusProjectionIntentsById,
  lockCorpusProjectionOfflineRequest,
} from "@/api/lib/db/aggregate-lock";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { unattestedCorpusIndexIdsTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  type CorpusIndexManifest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_APPEND_CANCEL_REASON,
  CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS,
  type CorpusIndexAppendFault,
  type CorpusIndexIntentStatus,
  type CorpusIndexProjectionAppendMode,
  type CorpusIndexProjectionFailureKind,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  lockActiveCorpusProjectionManifestForMutation,
  lockRegisteredCorpusProjectionManifestForMutation,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  type CorpusProjectionPresenceCensus,
  type CorpusProjectionPresenceProof,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS,
  corpusProjectionAcceptedAppendCleanupFence,
  corpusProjectionAcceptedAppendProofDeadline,
  corpusProjectionAppendPublishBarrier,
  corpusProjectionOfflineIndexerEndedAt,
  corpusProjectionOfflineRequestLeaseFloor,
  corpusProjectionUnrecordedAppendCleanupFence,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  lockCorpusIndexProjectionMutationsTx,
  lockCorpusIndexProjectionWriterTx,
} from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  type CorpusProjectionAppendScopedWorkOptions,
  entityIdsForCorpusProjectionWorkScope,
  indexIdForCorpusProjectionWorkScope,
} from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  corpusIndexProjectionIntentIsOutstanding,
  corpusIndexProjectionProducesAppend,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

export const CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE =
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS;
export const CORPUS_PROJECTION_LEASE_MIN_MS = 5000;
export const CORPUS_PROJECTION_LEASE_MAX_MS = 15 * 60_000;

type ProjectionIntentId = SafeId<"corpusIndexProjectionIntent">;

export type CorpusProjectionIntentLease = {
  intentId: ProjectionIntentId;
  family: CorpusFamily;
  generation: string;
  entityId: string;
  epoch: bigint;
  fingerprint: string;
  indexId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  appendMode: CorpusIndexProjectionAppendMode;
};

type ReserveCorpusProjectionIntentsOptions<Family extends CorpusFamily> =
  CorpusProjectionAppendScopedWorkOptions<Family> & {
    generation: string;
    limit: number;
    leaseMs: number;
    /** Deterministic database-test clock; production expiry uses PostgreSQL. */
    testNow?: Date;
    newIntentId?: () => ProjectionIntentId;
    newLeaseToken?: () => string;
  };

const validateBatchSize = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE
  ) {
    return panic(
      `Corpus projection store batch size must be an integer from 1 to ${CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE}`,
    );
  }
  return limit;
};

const validateLeaseMs = (leaseMs: number): number => {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < CORPUS_PROJECTION_LEASE_MIN_MS ||
    leaseMs > CORPUS_PROJECTION_LEASE_MAX_MS
  ) {
    return panic(
      `Corpus projection lease must be an integer from ${CORPUS_PROJECTION_LEASE_MIN_MS} to ${CORPUS_PROJECTION_LEASE_MAX_MS} milliseconds`,
    );
  }
  return leaseMs;
};

const corpusProjectionStateLockOrder = () => [
  asc(corpusIndexProjectionStates.entityId),
];

const readPostgresClock = async (tx: Transaction): Promise<Date> => {
  const rows = await tx
    .select({ value: sql<Date | string>`clock_timestamp()` })
    .from(sql`(SELECT 1) AS projection_clock`);
  const raw = rows.at(0)?.value;
  const value = raw instanceof Date ? raw : new Date(raw ?? Number.NaN);
  if (!Number.isFinite(value.getTime())) {
    return panic("PostgreSQL did not return the projection clock");
  }
  return value;
};

/**
 * Reserve exact append attempts only after every earlier revision for the
 * entity is terminal. The revision a state serves is not terminal, so a
 * replacement waits here, served at its current revision; nothing queues a
 * served revision for cleanup to make room. The operator controls how often
 * and how broadly this bounded primitive runs.
 */
export const reserveCorpusProjectionIntentsTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  options: ReserveCorpusProjectionIntentsOptions<Family>,
): Promise<CorpusProjectionIntentLease[]> =>
  (
    await reserveFromQueueTx(tx, options, {
      after: null,
      batchableOnly: false,
      skipEntityIds: [],
    })
  ).leases;

type ReserveCorpusProjectionRoutePageOptions<Family extends CorpusFamily> =
  Omit<ReserveCorpusProjectionIntentsOptions<Family>, "scope"> & {
    indexId: string;
    /** The previous page's `cursor`, or null to walk from the queue's head. */
    after: CorpusProjectionReservationQueueKey | null;
    /** Entities the walker will not take this time; they keep their place. */
    skipEntityIds: readonly string[];
  };

export type CorpusProjectionRoutePage = {
  type: "page";
  leases: CorpusProjectionIntentLease[];
  /**
   * The last queue position this page read, whether or not it reserved it;
   * the next page starts after it. Null only when the walk has read nothing
   * yet. A page that read nothing returns the cursor it was given.
   */
  cursor: CorpusProjectionReservationQueueKey | null;
  /** The page read fewer candidates than its limit: the walk is at its end. */
  exhausted: boolean;
};

/**
 * One page of a walk over one route's reservation queue, for a producer that
 * reserves many pages in a row. The reservation is the per-row path's own
 * (same queue, same per-entity claim, same leases); the page only starts
 * after the previous page's last position, so reserved and unproven entities
 * at the head of the queue are not read again on every page. Correctness
 * still rests on the claim, not the cursor: a state whose position moves
 * behind the cursor is left to the per-row path, which owns completeness.
 * Only batchable entities are taken; one isolated into single requests stays
 * with the per-row path.
 */
export const reserveCorpusProjectionRoutePageTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    indexId,
    after,
    skipEntityIds,
    ...options
  }: ReserveCorpusProjectionRoutePageOptions<Family>,
): Promise<CorpusProjectionRoutePage | { type: "generation_not_building" }> => {
  // The queue admits a serving generation too; a route build reserves only
  // while its generation is still building. The status is read under the
  // projection mutation fence the reservation itself holds: a promotion takes
  // that fence exclusively, so it either committed before this read or waits
  // for the reservation to commit.
  await lockCorpusIndexProjectionWriterTx(tx);
  const [generationRow] = await tx
    .select({ status: corpusIndexGenerations.status })
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, options.family),
        eq(corpusIndexGenerations.generation, options.generation),
      ),
    )
    .limit(1);
  if (generationRow?.status !== "building") {
    return { type: "generation_not_building" };
  }
  return await reserveFromQueueTx(
    tx,
    { ...options, scope: { type: "route", indexId } },
    { after, batchableOnly: true, skipEntityIds },
  );
};

const reserveFromQueueTx = async <Family extends CorpusFamily>(
  tx: Transaction,
  {
    family,
    generation,
    limit: requestedLimit,
    leaseMs: requestedLeaseMs,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    testNow,
    newIntentId = () => createSafeId<"corpusIndexProjectionIntent">(),
    newLeaseToken = () => Bun.randomUUIDv7(),
  }: ReserveCorpusProjectionIntentsOptions<Family>,
  {
    after,
    batchableOnly,
    skipEntityIds,
  }: {
    after: CorpusProjectionReservationQueueKey | null;
    batchableOnly: boolean;
    skipEntityIds: readonly string[];
  },
): Promise<CorpusProjectionRoutePage> => {
  // audit: skip - reservation bookkeeping on the derived public corpus projection
  const limit = validateBatchSize(requestedLimit);
  const leaseMs = validateLeaseMs(requestedLeaseMs);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  const manifest = await lockActiveCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const scopedIndexId = indexIdForCorpusProjectionWorkScope(scope, manifest);
  const excludedIndexIds = await unattestedCorpusIndexIdsTx(tx, manifest);
  if (scopedIndexId !== null && excludedIndexIds.includes(scopedIndexId)) {
    return { type: "page", leases: [], cursor: after, exhausted: true };
  }
  const eligibilityAt = testNow ?? (await readPostgresClock(tx));
  const candidates = await corpusProjectionReservationQueue(tx, {
    family,
    generation,
    limit,
    eligibilityAt,
    scopedEntityIds,
    scopedIndexId,
    excludedIndexIds,
    after,
    batchableOnly,
    skipEntityIds,
  });

  const last = candidates.at(-1);
  const cursor =
    last === undefined
      ? after
      : { runnableAt: last.runnableAt, entityId: last.entityId };
  const exhausted = candidates.length < limit;
  if (candidates.length === 0) {
    return { type: "page", leases: [], cursor, exhausted };
  }
  const leaseExpiresAt =
    testNow === undefined
      ? (
          await tx
            .select({
              value: sql<Date>`clock_timestamp() + ${leaseMs} * INTERVAL '1 millisecond'`,
            })
            .from(sql`(SELECT 1) AS projection_clock`)
        ).at(0)?.value
      : new Date(testNow.getTime() + leaseMs);
  if (leaseExpiresAt === undefined) {
    return panic("PostgreSQL did not return the projection lease expiry");
  }
  const reservations = candidates.map((candidate) => {
    if (candidate.fingerprint === null || candidate.indexId === null) {
      return panic(
        `Upsert projection state is missing its fingerprint or index: ${family}/${generation}/${candidate.entityId}`,
      );
    }
    return {
      intentId: newIntentId(),
      family,
      generation,
      entityId: candidate.entityId,
      epoch: candidate.epoch,
      fingerprint: candidate.fingerprint,
      indexId: candidate.indexId,
      leaseToken: newLeaseToken(),
      appendMode: candidate.appendMode,
    } satisfies Omit<CorpusProjectionIntentLease, "leaseExpiresAt">;
  });
  const inserted = await tx
    .insert(corpusIndexProjectionIntents)
    .values(
      reservations.map(
        (reservation) =>
          ({
            id: reservation.intentId,
            family: reservation.family,
            generation: reservation.generation,
            entityId: reservation.entityId,
            epoch: reservation.epoch,
            fingerprint: reservation.fingerprint,
            indexId: reservation.indexId,
            status: "reserved",
            leaseToken: reservation.leaseToken,
            leaseExpiresAt,
          }) satisfies typeof corpusIndexProjectionIntents.$inferInsert,
      ),
    )
    .onConflictDoNothing({
      target: [
        corpusIndexProjectionIntents.family,
        corpusIndexProjectionIntents.generation,
        corpusIndexProjectionIntents.entityId,
        corpusIndexProjectionIntents.epoch,
      ],
      where: corpusIndexProjectionProducesAppend(
        corpusIndexProjectionIntents.status,
      ),
    })
    .returning({
      id: corpusIndexProjectionIntents.id,
      leaseExpiresAt: corpusIndexProjectionIntents.leaseExpiresAt,
    });
  const expiryByIntentId = new Map(
    inserted.map(({ id, leaseExpiresAt: insertedExpiry }) => {
      if (insertedExpiry === null) {
        return panic(`Reserved projection intent has no lease expiry: ${id}`);
      }
      return [id, insertedExpiry] as const;
    }),
  );
  const leases: CorpusProjectionIntentLease[] = [];
  for (const reservation of reservations) {
    const insertedExpiry = expiryByIntentId.get(reservation.intentId);
    if (insertedExpiry === undefined) {
      continue;
    }
    leases.push({
      intentId: reservation.intentId,
      family: reservation.family,
      generation: reservation.generation,
      entityId: reservation.entityId,
      epoch: reservation.epoch,
      fingerprint: reservation.fingerprint,
      indexId: reservation.indexId,
      leaseToken: reservation.leaseToken,
      leaseExpiresAt: insertedExpiry,
      appendMode: reservation.appendMode,
    });
  }
  return { type: "page", leases, cursor, exhausted };
};

/**
 * Which half of the start predicate rejected this reserved revision. Both
 * cancel paths read it off the row instead of naming a reason at the call
 * site, so the two causes cannot be filed under one message again.
 * PostgreSQL evaluates a SET expression against the pre-update row, so the
 * lease read here is still the one the start attempt tested.
 *
 * The parameter is a settled `Date`, never a SQL expression: the caller must
 * have read one clock for the start attempt and this cancellation, or the two
 * statements would compare the same lease against two different instants.
 */
const appendCancelReason = (
  transitionAt: Date,
  unattestedIndexIds: readonly string[],
): SQL<string> =>
  sql<string>`CASE
    WHEN ${corpusIndexProjectionIntents.leaseExpiresAt} IS NULL
      OR ${corpusIndexProjectionIntents.leaseExpiresAt} <= ${transitionAt}::timestamptz
    THEN ${CORPUS_INDEX_APPEND_CANCEL_REASON.leaseExpired}
    ${
      unattestedIndexIds.length === 0
        ? sql``
        : sql`WHEN ${inArray(corpusIndexProjectionIntents.indexId, [...unattestedIndexIds])}
    THEN ${CORPUS_INDEX_APPEND_CANCEL_REASON.groupNotAttested}`
    }
    ELSE ${CORPUS_INDEX_APPEND_CANCEL_REASON.desiredStateChanged}
  END`;

/**
 * The append-start half of the attestation gate. Reservation already skips an
 * unattested group, but its attestation can be withdrawn between reservation
 * and start, so the start rechecks it after the generation fence and before
 * the state and intent locks. The attested rows stay share-locked until the
 * start commits, so a concurrent withdrawal waits for it; a withdrawal after
 * that commit meets a request already started, which settles like any other.
 * A revision refused here is cancelled, not failed: its desired state still
 * needs work and is reserved again once the group is attested.
 */
const unattestedAtAppendStart = async (
  tx: Transaction,
  manifest: CorpusIndexManifest,
): Promise<string[]> =>
  await unattestedCorpusIndexIdsTx(tx, manifest, { lock: "share" });

const attestedAtAppendStart = (unattestedIndexIds: readonly string[]) =>
  unattestedIndexIds.length === 0
    ? undefined
    : notInArray(corpusIndexProjectionIntents.indexId, [...unattestedIndexIds]);

type StartCorpusProjectionAppendOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  testNow?: Date;
};

export const startCorpusProjectionAppendTx = async (
  tx: Transaction,
  { intentId, leaseToken, testNow }: StartCorpusProjectionAppendOptions,
): Promise<"started" | "stale_cancelled" | "lease_lost"> => {
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .limit(1);
  const identity = identities.at(0);
  if (identity === undefined) {
    return "lease_lost";
  }
  const manifest = await lockActiveCorpusProjectionManifestForMutation(
    tx,
    identity.family,
    identity.generation,
  );
  const unattestedIndexIds = await unattestedAtAppendStart(tx, manifest);
  await tx
    .select({ entityId: corpusIndexProjectionStates.entityId })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, identity.family),
        eq(corpusIndexProjectionStates.generation, identity.generation),
        eq(corpusIndexProjectionStates.entityId, identity.entityId),
      ),
    )
    .limit(1)
    .for("update");
  const lockedIntents = await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .limit(1)
    .for("update");
  if (lockedIntents.length === 0) {
    return "lease_lost";
  }
  // One clock for the start attempt and the cancellation that reads why it
  // failed. `clock_timestamp()` is volatile, so leaving it in the statements
  // would let a lease that was live when the start was rejected read as
  // expired a moment later and take the blame from the desired state.
  const transitionAt = testNow ?? (await readPostgresClock(tx));
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "append_started",
      appendStartedAt: transitionAt,
      appendRequestRevisionCount: 1,
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
        sql`${corpusIndexProjectionIntents.leaseExpiresAt} > ${transitionAt}::timestamptz`,
        attestedAtAppendStart(unattestedIndexIds),
        sql`EXISTS (
          SELECT 1
          FROM ${corpusIndexProjectionStates} state
          WHERE state.family = ${corpusIndexProjectionIntents.family}
            AND state.generation = ${corpusIndexProjectionIntents.generation}
            AND state.entity_id = ${corpusIndexProjectionIntents.entityId}
            AND state.desired_action = 'upsert'
            AND state.desired_epoch = ${corpusIndexProjectionIntents.epoch}
            AND state.desired_fingerprint = ${corpusIndexProjectionIntents.fingerprint}
            AND state.desired_index_id = ${corpusIndexProjectionIntents.indexId}
        )`,
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length === 1) {
    return "started";
  }
  const cancelled = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cancelled",
      leaseToken: null,
      leaseExpiresAt: null,
      cancelledAt: transitionAt,
      lastError: appendCancelReason(transitionAt, unattestedIndexIds),
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  return cancelled.length === 1 ? "stale_cancelled" : "lease_lost";
};

export type CorpusProjectionAppendStart = {
  intentId: ProjectionIntentId;
  status: "started" | "stale_cancelled" | "lease_lost";
};

type StartCorpusProjectionAppendBatchOptions = {
  leases: readonly CorpusProjectionIntentLease[];
  testNow?: Date | undefined;
};

/**
 * How the started revisions travel. An ingest request is its own
 * transaction. An offline request is one indexer file, started in one or
 * more transactions that all carry its identity and its planned total, with
 * the documents the file holds for each revision.
 */
type CorpusProjectionAppendStartDelivery =
  | { type: "ingest_api" }
  | {
      type: "offline_indexer";
      expectedDocumentCounts: ReadonlyMap<ProjectionIntentId, number>;
      request: CorpusProjectionOfflineRequest;
      /** The request's first start, when an earlier transaction made one. */
      requestStartedAt: Date | null;
    };

/** A lease an offline transaction left reserved, and why. */
type CorpusProjectionOfflineNotStarted = {
  intentId: ProjectionIntentId;
  status: "not_started";
  /**
   * - `start_window_closed`: the request's first start is past the start
   *   window (`CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS`).
   * - `lease_ends_before_run`: the lease would expire before the request's
   *   kill deadline plus the record margin
   *   (`corpusProjectionOfflineRequestLeaseFloor`).
   */
  reason: "start_window_closed" | "lease_ends_before_run";
};

export type CorpusProjectionOfflineStart =
  CorpusProjectionAppendStart | CorpusProjectionOfflineNotStarted;

type AppendStartTransaction = {
  /** The request's first start after this transaction, or null for none. */
  requestStartedAt: Date | null;
  outcomes: CorpusProjectionOfflineStart[];
};

/**
 * Fence one physical append request and give every included revision one DB
 * timestamp after all state locks are held. Recovery can therefore anchor its
 * unknown-outcome barrier to the actual request boundary, not to an earlier
 * per-revision lock wait.
 */
export const startCorpusProjectionAppendBatchTx = async (
  tx: Transaction,
  { leases, testNow }: StartCorpusProjectionAppendBatchOptions,
): Promise<CorpusProjectionAppendStart[]> =>
  (
    await startAppendBatchTx(tx, {
      leases,
      delivery: { type: "ingest_api" },
      testNow,
    })
  ).outcomes.map((outcome) =>
    outcome.status === "not_started"
      ? panic(`An ingest request left ${outcome.intentId} unstarted`)
      : outcome,
  );

type OfflineCorpusProjectionAppendLease = {
  lease: CorpusProjectionIntentLease;
  /** Documents the indexer's file holds for this revision. */
  expectedDocumentCount: number;
};

/** One offline request: one indexer file over revisions of one index. */
export type CorpusProjectionOfflineRequest = {
  /** A fresh UUID for this request, never reused, carried by each revision. */
  requestId: string;
  /** The revisions the file will hold if every transaction starts them all. */
  plannedRevisionCount: number;
};

type StartCorpusProjectionOfflineRequestChunkOptions = {
  request: CorpusProjectionOfflineRequest;
  /**
   * The next leases of the request, at most one transaction's worth
   * (`CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE`), none started before.
   */
  leases: readonly OfflineCorpusProjectionAppendLease[];
  testNow?: Date | undefined;
};

/**
 * Start the next leases of one offline request, in one short transaction. A
 * request of up to `CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS` revisions is
 * started in as many such transactions as it needs, one after another; each
 * is the size an ingest request's start is, so no transaction holds more row
 * locks, parameters or guard work than one ingest start does. All of them run
 * before the file exists, so every document the indexer can write belongs to
 * a started row, and the file holds exactly the revisions that started.
 *
 * - The request's run is killed by the kill deadline of `requestStartedAt`,
 *   its first start, which is safe for every revision of it.
 * - A transaction later than the start window after that first start starts
 *   nothing; a lease that would expire before the kill deadline plus the
 *   record margin is not started. Both stay reserved for the caller to hand
 *   back (`cancelCorpusProjectionReservationTx`).
 * - A request larger than any of its revisions' caps is refused, against the
 *   planned total, whichever transaction carries the revision.
 * - A crash between transactions leaves the started part of the request and
 *   the rest reserved: the run, if any, holds only the started part, and the
 *   number delivered together is read from the started rows, never from the
 *   planned total (`readCorpusProjectionOfflineRequestCapsTx`).
 */
export const startCorpusProjectionOfflineRequestChunkTx = async (
  tx: Transaction,
  {
    request: given,
    leases,
    testNow,
  }: StartCorpusProjectionOfflineRequestChunkOptions,
): Promise<AppendStartTransaction> => {
  // One spelling per request: PostgreSQL compares uuids by value, but the
  // request lock hashes the text, so every transaction of a request must
  // pass the same text whatever case its caller wrote.
  const request = { ...given, requestId: given.requestId.toLowerCase() };
  const first = leases.at(0)?.lease;
  if (
    first === undefined ||
    !isUuid(request.requestId) ||
    !Number.isSafeInteger(request.plannedRevisionCount) ||
    request.plannedRevisionCount < leases.length ||
    request.plannedRevisionCount > CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS ||
    leases.some(({ lease }) => lease.indexId !== first.indexId)
  ) {
    return panic("Corpus projection offline request is invalid");
  }
  if (
    leases.some(
      ({ expectedDocumentCount }) =>
        !Number.isSafeInteger(expectedDocumentCount) ||
        expectedDocumentCount < 1,
    )
  ) {
    return panic("Projection append document count must be a positive integer");
  }
  // Start transactions of one request run one at a time, so the count of
  // what earlier ones started is final while this one starts more.
  await lockCorpusProjectionOfflineRequest(tx, request.requestId);
  const caps = await readCorpusProjectionOfflineRequestCapsTx(
    tx,
    leases.map(({ lease }) => lease),
  );
  if (
    leases.some(
      ({ lease }) =>
        request.plannedRevisionCount > (caps.get(lease.intentId) ?? 0),
    )
  ) {
    return panic(
      "An offline request holds a revision past its request cap; read the caps first",
    );
  }
  const started = await readOfflineRequestTx(tx, request, first);
  if (started.count + leases.length > request.plannedRevisionCount) {
    return panic("An offline request starts more revisions than it planned");
  }
  return await startAppendBatchTx(tx, {
    leases: leases.map(({ lease }) => lease),
    delivery: {
      type: "offline_indexer",
      expectedDocumentCounts: new Map(
        leases.map(({ lease, expectedDocumentCount }) => [
          lease.intentId,
          expectedDocumentCount,
        ]),
      ),
      request,
      requestStartedAt: started.firstStartedAt,
    },
    testNow,
  });
};

const instantOf = (raw: Date | string | null): Date | null => {
  if (raw === null) {
    return null;
  }
  const value = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(value.getTime())
    ? value
    : panic("PostgreSQL returned an invalid projection start");
};

/**
 * What earlier transactions of one offline request started: how many, and
 * its first start. Every row must belong to the same index and plan.
 */
const readOfflineRequestTx = async (
  tx: Transaction,
  request: CorpusProjectionOfflineRequest,
  lease: CorpusProjectionIntentLease,
): Promise<{ count: number; firstStartedAt: Date | null }> => {
  const intents = corpusIndexProjectionIntents;
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::integer`,
      firstStartedAt: sql<
        Date | string | null
      >`min(${intents.appendStartedAt})`,
      consistent: sql<boolean>`coalesce(bool_and(
        ${intents.family} = ${lease.family}
        AND ${intents.generation} = ${lease.generation}
        AND ${intents.indexId} = ${lease.indexId}
        AND ${intents.appendRequestRevisionCount} = ${request.plannedRevisionCount}
      ), true)`,
    })
    .from(intents)
    .where(eq(intents.appendRequestId, request.requestId));
  if (row === undefined || !row.consistent) {
    return panic("An offline request's revisions disagree on its plan");
  }
  return { count: row.count, firstStartedAt: instantOf(row.firstStartedAt) };
};

/**
 * How many revisions each offline request delivered together: the rows that
 * carry its identity, which are exactly the ones that started, whatever the
 * plan said. A request's transactions all fall inside its start window, which
 * ends long before any of its revisions can be decided, so the count is final
 * by then.
 */
const readOfflineDeliveredCountsTx = async (
  tx: Transaction,
  requestIds: readonly string[],
): Promise<Map<string, number>> => {
  const unique = [...new Set(requestIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      requestId: corpusIndexProjectionIntents.appendRequestId,
      delivered: sql<number>`count(*)::integer`,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.appendRequestId, unique))
    .groupBy(corpusIndexProjectionIntents.appendRequestId);
  return new Map(
    rows.map(({ requestId, delivered }) => [
      requestId ?? panic("An offline request count lost its identity"),
      delivered,
    ]),
  );
};

/**
 * How many revisions one revision was delivered together with, for a query
 * over the intents table: an ingest request's own count, or for an offline
 * request the rows that carry its identity, which are exactly the ones that
 * started (`readOfflineDeliveredCountsTx`), never its planned total.
 */
export const corpusProjectionDeliveredTogether = () => {
  const intents = corpusIndexProjectionIntents;
  return sql<number | null>`CASE
    WHEN ${intents.appendRequestId} IS NULL
      THEN ${intents.appendRequestRevisionCount}
    ELSE (
      SELECT count(*)::integer
      FROM ${intents} delivered
      WHERE delivered.append_request_id = ${intents.appendRequestId}
    )
  END`;
};

/** The same count for one locked revision. */
const deliveredTogetherTx = async (
  tx: Transaction,
  intent: Pick<
    typeof corpusIndexProjectionIntents.$inferSelect,
    "id" | "appendRequestId" | "appendRequestRevisionCount"
  >,
): Promise<number | null> =>
  intent.appendRequestId === null
    ? intent.appendRequestRevisionCount
    : ((await readOfflineDeliveredCountsTx(tx, [intent.appendRequestId])).get(
        intent.appendRequestId,
      ) ?? panic(`Offline request has no delivered count: ${intent.id}`));

/**
 * The largest offline request a revision may start in, given the fewest
 * revisions delivered together with one of its entity's earlier revisions at
 * the same epoch that was withdrawn, or retired from a request killed at its
 * deadline without ever being applied: half of them, at least one. An offline
 * run that publishes nothing cannot say which revision, if any, was at fault,
 * so a withdrawal from a request of several revisions charges no one and
 * switches no mode; each one halves the request instead. A revision that
 * keeps its run from publishing is alone after at most floor(log2 N)
 * withdrawals from a request of N, where a withdrawal is charged like any
 * isolated document fault and blocks the entity at the attempt limit: at
 * most floor(log2 N) + 5 deliveries, 18 for a request of 8192. A killed run
 * of many entities, or one that failed on what its file held, leaves each of
 * them in requests of half the size, still batched; a refused, undelivered or
 * crashed one says nothing about its documents and halves nothing.
 */
const corpusProjectionOfflineRequestCap = (
  fewestDeliveredWithdrawn: number | null,
): number =>
  fewestDeliveredWithdrawn === null
    ? CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS
    : Math.max(1, Math.floor(fewestDeliveredWithdrawn / 2));

/**
 * Each lease's request cap (`corpusProjectionOfflineRequestCap`), from the
 * withdrawn revisions of its entity at its epoch whose delivery could have
 * failed on its documents, and those retired from a request killed at its
 * deadline, and the number each one's request actually delivered. Those
 * rows are history, so the cap survives
 * any crash, and the lease is the entity's only outstanding revision, so it
 * cannot shrink while the lease is held.
 */
export const readCorpusProjectionOfflineRequestCapsTx = async (
  tx: Transaction,
  leases: readonly CorpusProjectionIntentLease[],
): Promise<Map<ProjectionIntentId, number>> => {
  const first = leases.at(0);
  if (first === undefined) {
    return new Map();
  }
  if (
    leases.some(
      ({ family, generation }) =>
        family !== first.family || generation !== first.generation,
    )
  ) {
    return panic("Offline request caps are read for one generation");
  }
  const withdrawn = await tx
    .select({
      entityId: corpusIndexProjectionIntents.entityId,
      epoch: corpusIndexProjectionIntents.epoch,
      requestId: corpusIndexProjectionIntents.appendRequestId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, first.family),
        eq(corpusIndexProjectionIntents.generation, first.generation),
        inArray(corpusIndexProjectionIntents.entityId, [
          ...new Set(leases.map(({ entityId }) => entityId)),
        ]),
        or(
          // A withdrawal whose delivery said nothing about its documents (a
          // refusal, a crash, a failure outside the indexer) halves nothing.
          and(
            eq(corpusIndexProjectionIntents.status, "withdrawn"),
            inArray(corpusIndexProjectionIntents.appendFault, [
              "documents",
              "killed",
            ]),
          ),
          // A revision retired from a request killed at its deadline (part
          // of it published, part not) is no less suspect than one withdrawn
          // from it: it halves too. One retired from a request its indexer
          // ran to a verdict left its entity in single requests instead.
          and(
            eq(corpusIndexProjectionIntents.appendFault, "killed"),
            // Retired, never applied: an applied revision a later exact
            // repair cleaned up was delivered in full and halves nothing.
            isNull(corpusIndexProjectionIntents.appliedAt),
            inArray(corpusIndexProjectionIntents.status, [
              "cleanup_pending",
              "cleanup_started",
              "cleanup_committed",
              "cleanup_stalled",
              "settled",
            ]),
          ),
        ),
      ),
    );
  const delivered = await readOfflineDeliveredCountsTx(
    tx,
    withdrawn.map(
      ({ requestId }) =>
        requestId ?? panic("A withdrawn revision has no offline request"),
    ),
  );
  const fewest = (entityId: string, epoch: bigint): number | null => {
    const counts = withdrawn
      .filter((row) => row.entityId === entityId && row.epoch === epoch)
      .map(
        ({ requestId }) =>
          delivered.get(requestId ?? "") ??
          panic("A withdrawn revision's request has no rows"),
      );
    return counts.length === 0 ? null : Math.min(...counts);
  };
  return new Map(
    leases.map(({ intentId, entityId, epoch }) => [
      intentId,
      corpusProjectionOfflineRequestCap(fewest(entityId, epoch)),
    ]),
  );
};

const startDelivery = (delivery: CorpusProjectionAppendStartDelivery) => {
  switch (delivery.type) {
    case "ingest_api":
      return { appendDelivery: delivery.type };
    case "offline_indexer":
      return {
        appendDelivery: delivery.type,
        appendRequestId: delivery.request.requestId,
        expectedDocumentCount: sqlCaseFragment({
          operand: sql`${corpusIndexProjectionIntents.id}`,
          branches: Array.from(
            delivery.expectedDocumentCounts,
            ([intentId, count]) =>
              sql`WHEN ${intentId}::uuid THEN ${count}::integer`,
          ),
          fallback: sql`${corpusIndexProjectionIntents.expectedDocumentCount}`,
        }),
      };
    default:
      delivery satisfies never;
      return panic(`Unhandled append delivery: ${String(delivery)}`);
  }
};

const startAppendBatchTx = async (
  tx: Transaction,
  {
    leases,
    delivery,
    testNow,
  }: StartCorpusProjectionAppendBatchOptions & {
    delivery: CorpusProjectionAppendStartDelivery;
  },
): Promise<AppendStartTransaction> => {
  // audit: skip - append bookkeeping on the derived public corpus projection
  const first = leases.at(0);
  if (
    first === undefined ||
    leases.length > CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE
  ) {
    return panic("Corpus projection append-start batch is invalid");
  }
  const intentIds = new Set(leases.map(({ intentId }) => intentId));
  const entityIds = new Set(leases.map(({ entityId }) => entityId));
  if (
    intentIds.size !== leases.length ||
    entityIds.size !== leases.length ||
    leases.some(
      ({ family, generation }) =>
        family !== first.family || generation !== first.generation,
    )
  ) {
    return panic(
      "Corpus projection append-start leases must be unique and scoped",
    );
  }
  const manifest = await lockActiveCorpusProjectionManifestForMutation(
    tx,
    first.family,
    first.generation,
  );
  const unattestedIndexIds = await unattestedAtAppendStart(tx, manifest);
  const entityIdList = [...entityIds];
  await tx
    .select({ entityId: corpusIndexProjectionStates.entityId })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, first.family),
        eq(corpusIndexProjectionStates.generation, first.generation),
        inArray(corpusIndexProjectionStates.entityId, entityIdList),
      ),
    )
    .orderBy(...corpusProjectionStateLockOrder())
    .limit(leases.length)
    .for("update");
  const exactLeases = or(
    ...leases.map(({ intentId, leaseToken }) =>
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    ),
  );
  if (exactLeases === undefined) {
    return panic("Corpus projection append-start lease predicate is empty");
  }
  await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        exactLeases,
        eq(corpusIndexProjectionIntents.family, first.family),
        eq(corpusIndexProjectionIntents.generation, first.generation),
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(leases.length)
    .for("update");
  const transitionAt = testNow ?? (await readPostgresClock(tx));
  const offline = delivery.type === "offline_indexer" ? delivery : null;
  const requestStartedAt = offline?.requestStartedAt ?? transitionAt;
  if (
    offline !== null &&
    transitionAt.getTime() >
      requestStartedAt.getTime() + CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS
  ) {
    return {
      requestStartedAt: offline.requestStartedAt,
      outcomes: leases.map(({ intentId }) => ({
        intentId,
        status: "not_started",
        reason: "start_window_closed",
      })),
    };
  }
  const leaseFloor =
    offline === null
      ? null
      : corpusProjectionOfflineRequestLeaseFloor(requestStartedAt, manifest);
  const coversRun =
    leaseFloor === null
      ? undefined
      : sql`${corpusIndexProjectionIntents.leaseExpiresAt} >= ${leaseFloor}::timestamptz`;
  const started = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "append_started",
      appendStartedAt: transitionAt,
      appendRequestRevisionCount:
        offline?.request.plannedRevisionCount ?? leases.length,
      ...startDelivery(delivery),
      updatedAt: transitionAt,
    })
    .where(
      and(
        exactLeases,
        eq(corpusIndexProjectionIntents.family, first.family),
        eq(corpusIndexProjectionIntents.generation, first.generation),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        sql`${corpusIndexProjectionIntents.leaseExpiresAt} > ${transitionAt}::timestamptz`,
        coversRun,
        attestedAtAppendStart(unattestedIndexIds),
        sql`EXISTS (
          SELECT 1
          FROM ${corpusIndexProjectionStates} state
          WHERE state.family = ${corpusIndexProjectionIntents.family}
            AND state.generation = ${corpusIndexProjectionIntents.generation}
            AND state.entity_id = ${corpusIndexProjectionIntents.entityId}
            AND state.desired_action = 'upsert'
            AND state.desired_epoch = ${corpusIndexProjectionIntents.epoch}
            AND state.desired_fingerprint = ${corpusIndexProjectionIntents.fingerprint}
            AND state.desired_index_id = ${corpusIndexProjectionIntents.indexId}
        )`,
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  const startedIds = new Set(started.map(({ id }) => id));
  // An ingest request is its transaction, so it counts what started. An
  // offline request keeps its planned total; what it delivered is counted
  // from its rows.
  if (
    offline === null &&
    started.length > 0 &&
    started.length !== leases.length
  ) {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({ appendRequestRevisionCount: started.length })
      .where(
        inArray(
          corpusIndexProjectionIntents.id,
          started.map(({ id }) => id),
        ),
      );
  }
  // A lease too short for the run is left reserved, not cancelled: its
  // entity still wants the revision, and the caller hands it back.
  const cancelled = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cancelled",
      leaseToken: null,
      leaseExpiresAt: null,
      cancelledAt: transitionAt,
      lastError: appendCancelReason(transitionAt, unattestedIndexIds),
      updatedAt: transitionAt,
    })
    .where(
      and(
        exactLeases,
        eq(corpusIndexProjectionIntents.family, first.family),
        eq(corpusIndexProjectionIntents.generation, first.generation),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        coversRun === undefined
          ? undefined
          : or(
              coversRun,
              sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= ${transitionAt}::timestamptz`,
            ),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  const cancelledIds = new Set(cancelled.map(({ id }) => id));
  return {
    requestStartedAt:
      offline === null
        ? null
        : (offline.requestStartedAt ??
          (started.length > 0 ? transitionAt : null)),
    outcomes: leases.map((lease) =>
      appendStartOutcome(lease, {
        startedIds,
        cancelledIds,
        leaseFloor,
        transitionAt,
      }),
    ),
  };
};

/** What one start transaction did with one lease. */
const appendStartOutcome = (
  { intentId, leaseExpiresAt }: CorpusProjectionIntentLease,
  {
    startedIds,
    cancelledIds,
    leaseFloor,
    transitionAt,
  }: {
    startedIds: ReadonlySet<ProjectionIntentId>;
    cancelledIds: ReadonlySet<ProjectionIntentId>;
    /** The lease an offline start required, or null for an ingest start. */
    leaseFloor: Date | null;
    transitionAt: Date;
  },
): CorpusProjectionOfflineStart => {
  if (startedIds.has(intentId)) {
    return { intentId, status: "started" };
  }
  if (cancelledIds.has(intentId)) {
    return { intentId, status: "stale_cancelled" };
  }
  if (
    leaseFloor !== null &&
    leaseExpiresAt.getTime() > transitionAt.getTime() &&
    leaseExpiresAt.getTime() < leaseFloor.getTime()
  ) {
    return { intentId, status: "not_started", reason: "lease_ends_before_run" };
  }
  return { intentId, status: "lease_lost" };
};

/** A multipart revision owns the same lease throughout its sequential requests. */
export const startCorpusProjectionMultipartAppendTx = async (
  tx: Transaction,
  lease: CorpusProjectionIntentLease,
): Promise<CorpusProjectionAppendStart["status"]> => {
  const status =
    (await startCorpusProjectionAppendBatchTx(tx, { leases: [lease] })).at(0)
      ?.status ?? "lease_lost";
  if (status !== "started") {
    return status;
  }
  await tx
    .update(corpusIndexProjectionIntents)
    .set({
      leaseExpiresAt: sql<Date>`clock_timestamp() + ${CORPUS_PROJECTION_LEASE_MAX_MS} * interval '1 millisecond'`,
    })
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, lease.intentId),
        eq(corpusIndexProjectionIntents.leaseToken, lease.leaseToken),
        eq(corpusIndexProjectionIntents.status, "append_started"),
      ),
    );
  return "started";
};

/** Refresh the unknown-outcome fence immediately before a later physical part. */
export const continueCorpusProjectionAppendPartTx = async (
  tx: Transaction,
  lease: CorpusProjectionIntentLease,
): Promise<"started" | "lease_lost"> => {
  await lockActiveCorpusProjectionManifestForMutation(
    tx,
    lease.family,
    lease.generation,
  );
  await tx
    .select({ entityId: corpusIndexProjectionStates.entityId })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, lease.family),
        eq(corpusIndexProjectionStates.generation, lease.generation),
        eq(corpusIndexProjectionStates.entityId, lease.entityId),
      ),
    )
    .limit(1)
    .for("update");
  await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, lease.intentId))
    .limit(1)
    .for("update");
  const transitionAt = await readPostgresClock(tx);
  const continued = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      appendStartedAt: transitionAt,
      leaseExpiresAt: sql<Date>`clock_timestamp() + ${CORPUS_PROJECTION_LEASE_MAX_MS} * interval '1 millisecond'`,
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, lease.intentId),
        eq(corpusIndexProjectionIntents.leaseToken, lease.leaseToken),
        eq(corpusIndexProjectionIntents.status, "append_started"),
        sql`${corpusIndexProjectionIntents.leaseExpiresAt} > ${transitionAt}::timestamptz`,
        sql`EXISTS (
          SELECT 1 FROM ${corpusIndexProjectionStates} state
          WHERE state.family = ${corpusIndexProjectionIntents.family}
            AND state.generation = ${corpusIndexProjectionIntents.generation}
            AND state.entity_id = ${corpusIndexProjectionIntents.entityId}
            AND state.desired_action = 'upsert'
            AND state.desired_epoch = ${corpusIndexProjectionIntents.epoch}
            AND state.desired_fingerprint = ${corpusIndexProjectionIntents.fingerprint}
            AND state.desired_index_id = ${corpusIndexProjectionIntents.indexId}
        )`,
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  return continued.length === 1 ? "started" : "lease_lost";
};

type CorpusProjectionAppendFailureFault = "document" | "engine";

type AbandonCorpusProjectionAppendOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  testNow?: Date;
  errorMessage: string;
  rejection?: CorpusIndexError["rejection"];
  fault?: CorpusProjectionAppendFailureFault;
};

export type CorpusProjectionAppendAbandonResult =
  | { status: "cleanup_pending" }
  | {
      status: "blocked";
      entityId: string;
      kind: CorpusIndexProjectionFailureKind;
      attempts: number;
    }
  | { status: "lease_lost" };

export const CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT = 5;
const CORPUS_PROJECTION_APPEND_REJECTED_ATTEMPT_LIMIT = 2;
export const CORPUS_PROJECTION_APPEND_RETRY_BASE_MS = 5000;
export const CORPUS_PROJECTION_APPEND_RETRY_CAP_MS = 5 * 60_000;

type ProjectionFailureRowsOptions = {
  family: CorpusFamily;
  generation: string;
  entityId: string;
  intentId: ProjectionIntentId;
  leaseToken: string;
  status: "reserved" | "append_started";
};

/** Caller holds the writer lock; state must be locked before its intent. */
const lockProjectionFailureRowsTx = async (
  tx: Transaction,
  {
    family,
    generation,
    entityId,
    intentId,
    leaseToken,
    status,
  }: ProjectionFailureRowsOptions,
) => {
  const [state] = await tx
    .select()
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, entityId),
      ),
    )
    .limit(1)
    .for("update");
  const [intent] = await tx
    .select()
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, status),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .limit(1)
    .for("update");
  return { state, intent };
};

const isStillDesiredProjection = (
  state: typeof corpusIndexProjectionStates.$inferSelect | undefined,
  intent: typeof corpusIndexProjectionIntents.$inferSelect,
): state is typeof corpusIndexProjectionStates.$inferSelect =>
  state?.desiredAction === "upsert" &&
  state.desiredEpoch === intent.epoch &&
  state.desiredFingerprint === intent.fingerprint &&
  state.desiredIndexId === intent.indexId;

type AppendFailureChargeOptions = {
  state: typeof corpusIndexProjectionStates.$inferSelect;
  appendRequestRevisionCount: number | null;
  transitionAt: Date;
  rejection: CorpusIndexError["rejection"];
  fault: CorpusProjectionAppendFailureFault;
};

type AppendFailureCharge = {
  kind: CorpusIndexProjectionFailureKind;
  workStatus: "blocked" | "retry_scheduled";
  retryNotBefore: Date | null;
  failureAttempts: number;
  appendMode: CorpusIndexProjectionAppendMode;
};

/**
 * What a failed or unproven append costs its entity. Only a document fault
 * sent in a request of its own is charged; one sent with others splits the
 * entity into single appends uncharged, so one bad revision cannot block the
 * revisions it travelled with.
 */
const appendFailureCharge = ({
  state,
  appendRequestRevisionCount,
  transitionAt,
  rejection,
  fault,
}: AppendFailureChargeOptions): AppendFailureCharge => {
  let kind: CorpusIndexProjectionFailureKind = "append_unknown";
  if (rejection === "definite") {
    kind = "append_rejected";
  } else if (rejection === "transient") {
    kind = "append_transient";
  }
  const isolated = appendRequestRevisionCount === 1;
  const documentFault = fault === "document" && rejection !== "transient";
  const charged = documentFault && isolated;
  const failureAttempts = state.failureAttempts + (charged ? 1 : 0);
  let attemptLimit = CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT;
  if (rejection === "definite") {
    attemptLimit = CORPUS_PROJECTION_APPEND_REJECTED_ATTEMPT_LIMIT;
  }
  const blocked = charged && failureAttempts >= attemptLimit;
  const retryDelayMs = backoffDelay(
    Math.min(Math.max(failureAttempts - 1, 0), 6),
    {
      baseMs: CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
      maxMs: CORPUS_PROJECTION_APPEND_RETRY_CAP_MS,
    },
  );
  return {
    kind,
    workStatus: blocked ? "blocked" : "retry_scheduled",
    retryNotBefore: blocked
      ? null
      : new Date(transitionAt.getTime() + retryDelayMs),
    failureAttempts,
    appendMode: documentFault && !isolated ? "single" : state.appendMode,
  };
};

/** Failed append outcomes are assumed written and cleaned exactly before retry. */
export const abandonCorpusProjectionAppendTx = async (
  tx: Transaction,
  {
    intentId,
    leaseToken,
    testNow,
    errorMessage,
    rejection = "unknown",
    fault = "document",
  }: AbandonCorpusProjectionAppendOptions,
): Promise<CorpusProjectionAppendAbandonResult> => {
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "append_started"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .limit(1);
  const identity = identities.at(0);
  if (identity === undefined) {
    return { status: "lease_lost" };
  }
  await lockCorpusIndexProjectionMutationsTx(tx, [identity]);
  const manifest = await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    identity.family,
    identity.generation,
  );
  const { state, intent } = await lockProjectionFailureRowsTx(tx, {
    ...identity,
    intentId,
    leaseToken,
    status: "append_started",
  });
  if (intent === undefined) {
    return { status: "lease_lost" };
  }
  if (intent.appendStartedAt === null) {
    return panic(`Started projection intent has no start time: ${intent.id}`);
  }
  const barrier = corpusProjectionAppendPublishBarrier(
    { type: "unknown", appendStartedAt: intent.appendStartedAt },
    manifest,
  );
  const transitionAt = testNow ?? (await readPostgresClock(tx));
  await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      appendPublishBarrierAt: barrier,
      cleanupNotBefore: barrier,
      lastError: errorMessage.slice(0, 2048),
      updatedAt: transitionAt,
    })
    .where(eq(corpusIndexProjectionIntents.id, intentId));
  if (!isStillDesiredProjection(state, intent)) {
    return { status: "cleanup_pending" };
  }
  const charge = appendFailureCharge({
    state,
    appendRequestRevisionCount: await deliveredTogetherTx(tx, intent),
    transitionAt,
    rejection,
    fault,
  });
  const updated = await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: charge.workStatus,
      retryNotBefore: charge.retryNotBefore,
      failureAttempts: charge.failureAttempts,
      appendMode: charge.appendMode,
      lastFailureKind: charge.kind,
      lastFailureMessage: errorMessage.slice(0, 2048),
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, intent.family),
        eq(corpusIndexProjectionStates.generation, intent.generation),
        eq(corpusIndexProjectionStates.entityId, intent.entityId),
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        eq(corpusIndexProjectionStates.desiredEpoch, intent.epoch),
        eq(corpusIndexProjectionStates.desiredFingerprint, intent.fingerprint),
        eq(corpusIndexProjectionStates.desiredIndexId, intent.indexId),
      ),
    )
    .returning({ entityId: corpusIndexProjectionStates.entityId });
  if (updated.length !== 1) {
    return panic(`Projection append failure CAS failed: ${intent.id}`);
  }
  return charge.workStatus === "blocked"
    ? {
        status: "blocked",
        entityId: intent.entityId,
        kind: charge.kind,
        attempts: charge.failureAttempts,
      }
    : { status: "cleanup_pending" };
};

export type UnparkCorpusProjectionAppendOptions = {
  family: CorpusFamily;
  generation: string;
  entityId: string;
  reason: string;
};

export type CorpusProjectionAppendUnparkResult =
  "unparked" | "not_blocked" | "cleanup_pending";

/** Unpark one blocked entity after cleanup settles; retain singleton retry. */
export const unparkCorpusProjectionAppendTx = async (
  tx: Transaction,
  { family, generation, entityId, reason }: UnparkCorpusProjectionAppendOptions,
): Promise<CorpusProjectionAppendUnparkResult> => {
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0 || normalizedReason.length > 256) {
    return panic(
      "Corpus projection unpark reason must contain 1-256 characters",
    );
  }
  await lockCorpusIndexProjectionMutationsTx(tx, [{ family, generation }]);
  await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const [state] = await tx
    .select({ workStatus: corpusIndexProjectionStates.workStatus })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, entityId),
      ),
    )
    .limit(1)
    .for("update");
  if (state?.workStatus !== "blocked") {
    return "not_blocked";
  }
  const outstanding = await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        eq(corpusIndexProjectionIntents.entityId, entityId),
        corpusIndexProjectionIntentIsOutstanding(
          corpusIndexProjectionIntents.status,
        ),
      ),
    )
    .limit(1);
  if (outstanding.length > 0) {
    return "cleanup_pending";
  }
  await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: "eligible",
      retryNotBefore: null,
      failureAttempts: 0,
      lastFailureKind: null,
      lastFailureMessage: null,
      updatedAt: await readPostgresClock(tx),
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, entityId),
      ),
    );
  const { logger } = await import("@/api/lib/observability/logger");
  logger.info("corpus_projection.append_unparked", {
    family,
    generation,
    entity: entityId,
    reason: normalizedReason,
  });
  return "unparked";
};

const ACCEPTED_STATUS = "append_committed" satisfies CorpusIndexIntentStatus;
const APPLIED_STATUS = "applied" satisfies CorpusIndexIntentStatus;
const WITHDRAWN_STATUS = "withdrawn" satisfies CorpusIndexIntentStatus;
const CLEANUP_PENDING_STATUS =
  "cleanup_pending" satisfies CorpusIndexIntentStatus;
const STALE_ACCEPTED_APPEND_MESSAGE =
  "projection desired state changed after append accepted";

type AcceptedProjectionAppend = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  /** Documents the accepted request wrote for this revision. */
  documentCount: number;
};

/**
 * The recorded reason of a revision whose indexer was killed at its deadline
 * with the revision alone in its file: stored on the intent with its record,
 * and on its entity when that failure is charged, so blocks of this kind can
 * be found and unparked together.
 */
export const CORPUS_PROJECTION_OFFLINE_LONE_KILL_MESSAGE =
  "offline projection revision kept its indexer running to its kill deadline alone";

type RecordAcceptedCorpusProjectionAppendsOptions = {
  /** Revisions of one index whose append the engine accepted. */
  accepted: readonly AcceptedProjectionAppend[];
  /**
   * How every revision of the batch travelled; each must have started so.
   * An offline record states what a failure of its revisions is charged to
   * (`CORPUS_INDEX_APPEND_FAULTS`), stored with the commit for any prover.
   */
  delivery:
    | { type: "ingest_api" }
    | {
        type: "offline_indexer";
        fault: CorpusIndexAppendFault;
        /**
         * Killed at its deadline alone in its file: recorded with
         * `CORPUS_PROJECTION_OFFLINE_LONE_KILL_MESSAGE`.
         */
        killedAlone?: boolean;
      };
  testNow?: Date | undefined;
};

type RecordedCorpusProjectionAppend =
  | { status: "accepted"; intentId: ProjectionIntentId }
  | { status: "stale_cleanup_pending"; intentId: ProjectionIntentId }
  | { status: "lease_lost"; intentId: ProjectionIntentId };

type ProjectionRowsByIntent = {
  states: Map<string, typeof corpusIndexProjectionStates.$inferSelect>;
  intents: Map<
    ProjectionIntentId,
    typeof corpusIndexProjectionIntents.$inferSelect
  >;
};

type LockAcceptedProjectionRowsOptions = {
  intentIds: readonly ProjectionIntentId[];
  /** The one index every revision must belong to. */
  indexId: string | null;
};

type LockedAcceptedProjectionRows = ProjectionRowsByIntent & {
  manifest: CorpusIndexManifest;
};

/**
 * Lock the rows one accept or proof transaction decides on, in the order the
 * other projection writers take them: the mutation fence, the generation's
 * manifest, the states by entity, then the intents. One call covers one
 * index, so one generation.
 */
const lockAcceptedProjectionRowsTx = async (
  tx: Transaction,
  { intentIds, indexId }: LockAcceptedProjectionRowsOptions,
): Promise<LockedAcceptedProjectionRows | null> => {
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
      indexId: corpusIndexProjectionIntents.indexId,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, [...intentIds]));
  const identity = identities.at(0);
  if (identity === undefined) {
    return null;
  }
  if (
    identities.some(
      ({ family, generation, indexId: rowIndexId }) =>
        family !== identity.family ||
        generation !== identity.generation ||
        rowIndexId !== (indexId ?? identity.indexId),
    )
  ) {
    return panic("Accepted projection appends must name one index");
  }
  await lockCorpusIndexProjectionMutationsTx(tx, [identity]);
  const manifest = await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    identity.family,
    identity.generation,
  );
  const { states, intents } = await lockCorpusProjectionAcceptedRows(tx, {
    family: identity.family,
    generation: identity.generation,
    entityIds: [...new Set(identities.map(({ entityId }) => entityId))],
    intentIds,
  });
  return {
    manifest,
    states: new Map(states.map((state) => [state.entityId, state])),
    intents: new Map(intents.map((intent) => [intent.id, intent])),
  };
};

const validateAcceptedBatch = (intentIds: readonly ProjectionIntentId[]) => {
  if (
    intentIds.length === 0 ||
    intentIds.length > CORPUS_PROJECTION_APPEND_MAX_REVISIONS ||
    new Set(intentIds).size !== intentIds.length
  ) {
    panic(
      `Accepted projection appends must name 1 to ${CORPUS_PROJECTION_APPEND_MAX_REVISIONS} unique revisions`,
    );
  }
};

/**
 * Record the engine's acceptance of started appends. Each revision whose lease
 * still holds releases it and becomes `append_committed` with its document
 * count, its acceptance instant and the publish barrier counted from it; from
 * then on no owner is needed, because only presence evidence applies it. The
 * instant is read from PostgreSQL after the receipt, so it is never earlier
 * than the acceptance and the barrier stays sound. A revision whose desired
 * state moved meanwhile goes to cleanup behind the same barrier instead.
 *
 * An offline revision is recorded once its indexer has exited or been
 * killed, with the count its start stored. Its indexer published all it ever
 * will before that, so its barrier is the record itself; whether an inexact
 * count is final is still judged from its kill deadline, never from the exit
 * a caller reports (`settleCommittedCorpusProjectionAppendsTx`).
 */
export const recordAcceptedCorpusProjectionAppendsTx = async (
  tx: Transaction,
  { accepted, delivery, testNow }: RecordAcceptedCorpusProjectionAppendsOptions,
): Promise<RecordedCorpusProjectionAppend[]> => {
  // audit: skip - append bookkeeping on the derived public corpus projection
  validateAcceptedBatch(accepted.map(({ intentId }) => intentId));
  if (
    accepted.some(
      ({ documentCount }) =>
        !Number.isSafeInteger(documentCount) || documentCount < 1,
    )
  ) {
    return panic("Projection append document count must be a positive integer");
  }
  const rows = await lockAcceptedProjectionRowsTx(tx, {
    intentIds: accepted.map(({ intentId }) => intentId),
    indexId: null,
  });
  if (rows === null) {
    return accepted.map(({ intentId }) => ({ status: "lease_lost", intentId }));
  }
  const transitionAt = testNow ?? (await readPostgresClock(tx));
  const outcomes = accepted.map(({ intentId, leaseToken, documentCount }) => {
    const intent = rows.intents.get(intentId);
    if (
      intent?.status !== "append_started" ||
      intent.leaseToken !== leaseToken
    ) {
      return { status: "lease_lost", intentId, documentCount } as const;
    }
    if (intent.appendDelivery !== delivery.type) {
      return panic(
        `Projection append recorded as ${delivery.type} started as ${intent.appendDelivery}: ${intent.id}`,
      );
    }
    if (
      intent.appendDelivery === "offline_indexer" &&
      intent.expectedDocumentCount !== documentCount
    ) {
      return panic(`Projection append document count changed: ${intent.id}`);
    }
    return isStillDesiredProjection(rows.states.get(intent.entityId), intent)
      ? ({
          status: "accepted",
          intentId,
          documentCount,
          delivery: intent.appendDelivery,
        } as const)
      : ({ status: "stale_cleanup_pending", intentId, documentCount } as const);
  });
  const written = outcomes.filter(({ status }) => status !== "lease_lost");
  if (written.length > 0) {
    const byIntent = (
      selected: readonly { intentId: ProjectionIntentId }[],
      value: (outcome: (typeof written)[number]) => SQL,
      fallback: SQL,
    ) =>
      sqlCaseFragment({
        operand: sql`${corpusIndexProjectionIntents.id}`,
        branches: written
          .filter(({ intentId }) =>
            selected.some((outcome) => outcome.intentId === intentId),
          )
          .map(
            (outcome) =>
              sql`WHEN ${outcome.intentId}::uuid THEN ${value(outcome)}`,
          ),
        fallback,
      });
    const stale = written.filter(
      ({ status }) => status === "stale_cleanup_pending",
    );
    // A revision whose desired state moved meanwhile was accepted all the
    // same: it records the acceptance and its barrier and goes to cleanup
    // behind that barrier instead of awaiting proof.
    const fence = corpusProjectionUnrecordedAppendCleanupFence(
      rows.manifest,
      transitionAt,
    );
    // An offline run is recorded once its indexer has exited, and it
    // published everything it will before exiting: its barrier is the record
    // itself, with no commit window to wait out.
    const exited = written.filter(
      (outcome) =>
        outcome.status === "accepted" && outcome.delivery === "offline_indexer",
    );
    const exitedBarrier = corpusProjectionAppendPublishBarrier(
      { type: "offline_exited", exitedBy: transitionAt },
      rows.manifest,
    );
    const recorded = await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: byIntent(
          stale,
          () => sql`${CLEANUP_PENDING_STATUS}`,
          sql`${ACCEPTED_STATUS}`,
        ),
        leaseToken: null,
        leaseExpiresAt: null,
        appendCommittedAt: transitionAt,
        appendPublishBarrierAt: byIntent(
          exited,
          () => sql`${exitedBarrier}::timestamptz`,
          fence.appendPublishBarrierAt,
        ),
        cleanupNotBefore: byIntent(
          stale,
          () => fence.cleanupNotBefore,
          sql`NULL`,
        ),
        expectedDocumentCount: byIntent(
          written,
          ({ documentCount }) => sql`${documentCount}::integer`,
          sql`${corpusIndexProjectionIntents.expectedDocumentCount}`,
        ),
        lastError: byIntent(
          stale,
          () => sql`${STALE_ACCEPTED_APPEND_MESSAGE}`,
          delivery.type === "offline_indexer" && delivery.killedAlone === true
            ? sql`${CORPUS_PROJECTION_OFFLINE_LONE_KILL_MESSAGE}`
            : sql`${corpusIndexProjectionIntents.lastError}`,
        ),
        appendFault:
          delivery.type === "offline_indexer" ? delivery.fault : null,
        updatedAt: transitionAt,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            written.map(({ intentId }) => intentId),
          ),
          eq(corpusIndexProjectionIntents.status, "append_started"),
        ),
      )
      .returning({ id: corpusIndexProjectionIntents.id });
    if (recorded.length !== written.length) {
      return panic(
        `Projection acceptance recorded ${recorded.length} of ${written.length} locked revisions`,
      );
    }
  }
  return outcomes.map(({ status, intentId }) => ({ status, intentId }));
};

/**
 * When a census may decide a committed revision.
 *
 * - `after_barrier`: the proof cycle. An exact count applies once the stored
 *   barrier has passed by the PostgreSQL clock; an inexact one waits for the
 *   proof deadline and then retires the revision, charged like an unknown
 *   append outcome.
 *   An offline revision has no proof deadline: its inexact count is final
 *   only for a census that started once its indexer had certainly ended,
 *   which `censusStart` dates; without it the revision keeps waiting. Then an
 *   empty count withdraws it and any other retires it.
 * - `request_waited`: the executor, right after a request that waited for
 *   publication. An exact count applies at once; an inexact one retires the
 *   revision at once with an uncharged retry, as a transient append failure.
 */
export type CorpusProjectionProofTiming =
  | { type: "after_barrier"; censusStart?: CorpusProjectionCensusStart }
  | { type: "request_waited"; failureMessage: string };

type ProveAcceptedCorpusProjectionAppendsOptions = {
  indexId: string;
  /** One exact census of committed revisions of `indexId`. */
  census: CorpusProjectionPresenceCensus;
  timing: CorpusProjectionProofTiming;
  testNow?: Date | undefined;
};

export type AcceptedCorpusProjectionAppendProof =
  | { status: "applied"; intentId: ProjectionIntentId; entityId: string }
  /** Another prover applied it first. */
  | { status: "already_applied"; intentId: ProjectionIntentId }
  | { status: "stale_cleanup_pending"; intentId: ProjectionIntentId }
  | { status: "unproven_cleanup_pending"; intentId: ProjectionIntentId }
  /** Offline, and empty in a census that started after its indexer ended. */
  | { status: "withdrawn"; intentId: ProjectionIntentId }
  | {
      status: "blocked";
      intentId: ProjectionIntentId;
      entityId: string;
      kind: CorpusIndexProjectionFailureKind;
      attempts: number;
    }
  /** Before its barrier, or not exactly present before its proof deadline. */
  | { status: "awaiting_publication"; intentId: ProjectionIntentId }
  /** No longer committed: erasure or an earlier proof moved it. */
  | { status: "not_accepted"; intentId: ProjectionIntentId };

const UNPUBLISHED_APPEND_MESSAGE =
  "projection append was not exactly present at its proof deadline";
const UNDELIVERED_OFFLINE_APPEND_MESSAGE =
  "offline projection append was not exactly present once its indexer had ended";
const WITHDRAWN_OFFLINE_APPEND_MESSAGE =
  "offline projection append was absent once its indexer had ended";

type ProofDecision =
  | { type: "settled"; outcome: AcceptedCorpusProjectionAppendProof }
  | {
      type: "apply";
      intent: typeof corpusIndexProjectionIntents.$inferSelect;
    }
  | {
      type: "stale";
      intent: typeof corpusIndexProjectionIntents.$inferSelect;
    }
  | {
      type: "unproven";
      intent: typeof corpusIndexProjectionIntents.$inferSelect;
      charge: AppendFailureCharge;
      message: string;
    }
  | {
      type: "withdraw";
      intent: typeof corpusIndexProjectionIntents.$inferSelect;
      /** Null for a revision its state no longer wants: nothing to retry. */
      charge: AppendFailureCharge | null;
      message: string;
    };

/** A committed revision a census did not count exactly, or never counted. */
type UnprovenCommittedRevision = {
  revision: ProjectionIntentId;
  expectedDocumentCount: number;
  observedDocumentCount: number | null;
};

/** A count above what the append wrote is never proof; it is reported. */
const logExcessCounts = async (
  indexId: string,
  excess: readonly UnprovenCommittedRevision[],
): Promise<void> => {
  if (excess.length === 0) {
    return;
  }
  const { logger } = await import("@/api/lib/observability/logger");
  for (const revision of excess) {
    logger.warn("corpus_projection.append_excess", {
      indexId,
      revision: revision.revision,
      expected: revision.expectedDocumentCount,
      observed: revision.observedDocumentCount,
    });
  }
};

type SettleCommittedCorpusProjectionAppendsOptions = {
  indexId: string;
  proofs: readonly CorpusProjectionPresenceProof[];
  unproven: readonly UnprovenCommittedRevision[];
  timing: CorpusProjectionProofTiming;
  testNow?: Date | undefined;
};

/**
 * The one transition out of `append_committed` for the append path. A revision
 * becomes `applied`, with its authoritative state, only against presence
 * evidence the census constructed. A revision whose desired state moved goes
 * to cleanup behind its stored barrier; one not exactly present goes to
 * cleanup when its timing says so. Every branch is a compare-and-set on
 * `append_committed` under the state and intent locks, so two provers of the
 * same revision cannot both act on it.
 */
const settleCommittedCorpusProjectionAppendsTx = async (
  tx: Transaction,
  {
    indexId,
    proofs,
    unproven,
    timing,
    testNow,
  }: SettleCommittedCorpusProjectionAppendsOptions,
): Promise<AcceptedCorpusProjectionAppendProof[]> => {
  if (proofs.some((proof) => proof.indexId !== indexId)) {
    return panic(`Projection presence proof names another index: ${indexId}`);
  }
  const intentIds = [
    ...proofs.map(({ revision }) => revision),
    ...unproven.map(({ revision }) => revision),
  ];
  validateAcceptedBatch(intentIds);
  const rows = await lockAcceptedProjectionRowsTx(tx, { intentIds, indexId });
  if (rows === null) {
    return intentIds.map((intentId) => ({ status: "not_accepted", intentId }));
  }
  const { manifest, states, intents } = rows;
  const transitionAt = testNow ?? (await readPostgresClock(tx));
  const locked = (intentId: ProjectionIntentId, documentCount: number) => {
    const intent = intents.get(intentId);
    if (
      intent !== undefined &&
      intent.expectedDocumentCount !== null &&
      intent.expectedDocumentCount !== documentCount
    ) {
      return panic(`Projection append document count changed: ${intent.id}`);
    }
    return intent;
  };
  const context: ProofContext = {
    states,
    manifest,
    timing,
    transitionAt,
    delivered: await readOfflineDeliveredCountsTx(
      tx,
      [...intents.values()].flatMap(({ appendRequestId }) =>
        appendRequestId === null ? [] : [appendRequestId],
      ),
    ),
  };
  const excess: UnprovenCommittedRevision[] = [];
  const decisions: ProofDecision[] = [
    ...proofs.map((proof) =>
      decideProvenRevision(
        context,
        proof.revision,
        locked(proof.revision, proof.documentCount),
      ),
    ),
    ...unproven.map((revision) =>
      decideUnprovenRevision(
        context,
        revision,
        locked(revision.revision, revision.expectedDocumentCount),
        excess,
      ),
    ),
  ];

  await logExcessCounts(indexId, excess);
  const transitions = decisions.flatMap((decision) =>
    decision.type === "settled" ? [] : [decision],
  );
  if (transitions.length > 0) {
    await writeCorpusProjectionProofTransitionsTx(tx, {
      manifest,
      transitions,
      transitionAt,
    });
  }
  return decisions.map(proofOutcomeOf);
};

type CommittedIntentRow = typeof corpusIndexProjectionIntents.$inferSelect;

/** What every decision of one proof transaction reads. */
type ProofContext = {
  states: ReadonlyMap<string, typeof corpusIndexProjectionStates.$inferSelect>;
  manifest: CorpusIndexManifest;
  timing: CorpusProjectionProofTiming;
  transitionAt: Date;
  /** Revisions each offline request of the proof delivered together. */
  delivered: ReadonlyMap<string, number>;
};

/** Outcomes of a revision this proof can no longer act on, or null. */
const supersededDecision = (
  { states }: ProofContext,
  intentId: ProjectionIntentId,
  intent: CommittedIntentRow | undefined,
): ProofDecision | null => {
  if (intent === undefined) {
    return { type: "settled", outcome: { status: "not_accepted", intentId } };
  }
  const state = states.get(intent.entityId);
  if (intent.status === "applied" && state?.appliedRevision === intent.id) {
    return {
      type: "settled",
      outcome: { status: "already_applied", intentId },
    };
  }
  if (intent.status !== "append_committed" || intent.leaseToken !== null) {
    return { type: "settled", outcome: { status: "not_accepted", intentId } };
  }
  return null;
};

/**
 * Whether this census is final for an offline revision: it started once the
 * revision's indexer had certainly ended, both instants read from the
 * PostgreSQL clock. The transaction's own clock comes after the census and
 * cannot say when it looked.
 */
const censusFollowsOfflineEnd = (
  { manifest, timing }: ProofContext,
  intent: CommittedIntentRow,
): boolean => {
  if (
    intent.appendDelivery !== "offline_indexer" ||
    timing.type !== "after_barrier" ||
    timing.censusStart === undefined
  ) {
    return false;
  }
  const startedAt =
    intent.appendStartedAt ??
    panic(`Committed projection intent has no start: ${intent.id}`);
  return (
    corpusProjectionOfflineIndexerEndedAt(startedAt, manifest).getTime() <=
    timing.censusStart.at.getTime()
  );
};

/**
 * Whether a failure of this revision may be charged to its documents: always
 * for an ingest revision, whose request's own outcome decides, and for an
 * offline one only when its commit recorded that the indexer ran to its own
 * verdict (`CORPUS_INDEX_APPEND_FAULTS`).
 */
const offlineFaultIsDocuments = (intent: CommittedIntentRow): boolean => {
  if (intent.appendDelivery !== "offline_indexer") {
    return true;
  }
  const fault =
    intent.appendFault ??
    panic(`Committed offline projection intent has no fault: ${intent.id}`);
  switch (fault) {
    case "documents":
      return true;
    case "killed":
    case "none":
      return false;
    default:
      fault satisfies never;
      return panic(`Unhandled append fault: ${String(fault)}`);
  }
};

const committedBarrierOf = (intent: CommittedIntentRow) =>
  intent.appendPublishBarrierAt ??
  panic(`Committed projection intent has no barrier: ${intent.id}`);

const awaitingPublication = (intent: CommittedIntentRow): ProofDecision => ({
  type: "settled",
  outcome: { status: "awaiting_publication", intentId: intent.id },
});

/** A revision the census counted exactly: applied once its barrier passed. */
const decideProvenRevision = (
  context: ProofContext,
  intentId: ProjectionIntentId,
  intent: CommittedIntentRow | undefined,
): ProofDecision => {
  const superseded = supersededDecision(context, intentId, intent);
  if (superseded !== null) {
    return superseded;
  }
  const committed = intent ?? panic(`Lost proven intent ${intentId}`);
  if (
    !isStillDesiredProjection(context.states.get(committed.entityId), committed)
  ) {
    return { type: "stale", intent: committed };
  }
  const { timing, transitionAt } = context;
  switch (timing.type) {
    case "request_waited":
      return { type: "apply", intent: committed };
    case "after_barrier":
      return transitionAt.getTime() < committedBarrierOf(committed).getTime()
        ? awaitingPublication(committed)
        : { type: "apply", intent: committed };
    default:
      timing satisfies never;
      return panic(`Unhandled proof timing: ${String(timing)}`);
  }
};

/**
 * A revision the census did not count exactly. An offline one is decided only
 * by a census that started after its indexer had certainly ended: empty, it is
 * withdrawn; otherwise it is retired. Any other one waits for its proof
 * deadline, or is retired at once after a request that waited.
 */
const decideUnprovenRevision = (
  context: ProofContext,
  revision: UnprovenCommittedRevision,
  intent: CommittedIntentRow | undefined,
  excess: UnprovenCommittedRevision[],
): ProofDecision => {
  const superseded = supersededDecision(context, revision.revision, intent);
  if (superseded !== null) {
    return superseded;
  }
  const { manifest, timing, transitionAt } = context;
  const committed =
    intent ?? panic(`Lost unproven intent ${revision.revision}`);
  const state =
    context.states.get(committed.entityId) ??
    panic(`Committed projection intent has no state: ${committed.id}`);
  const offlineFinal = censusFollowsOfflineEnd(context, committed);
  const stillDesired = isStillDesiredProjection(state, committed);
  // The revisions delivered together with this one: an ingest request's own
  // count, or for an offline request the rows that actually started, never
  // its planned total.
  const deliveredTogether =
    committed.appendRequestId === null
      ? committed.appendRequestRevisionCount
      : (context.delivered.get(committed.appendRequestId) ??
        panic(`Offline request has no delivered count: ${committed.id}`));
  const charge = (
    rejection: CorpusIndexError["rejection"],
    fault: CorpusProjectionAppendFailureFault = "document",
  ) =>
    appendFailureCharge({
      state,
      appendRequestRevisionCount: deliveredTogether,
      transitionAt,
      rejection,
      // An offline revision's commit stored what its failure costs: only a
      // delivery the indexer ran to its own verdict charges the documents.
      fault: offlineFaultIsDocuments(committed) ? fault : "engine",
    });
  // Nothing of the revision reached the index and nothing can any more, so no
  // delete is owed, and no maturity waited for: the entity may be reserved
  // again once its retry is due. An empty run of several revisions cannot say
  // which, if any, was at fault, so such a withdrawal charges no one and keeps
  // the entity batched; its next request is capped instead
  // (`corpusProjectionOfflineRequestCap`). Alone in a request its indexer ran
  // to a verdict, it is a document fault like any other; one whose delivery
  // says nothing about its documents is never charged. A state that moved on
  // has nothing to retry. A lone kill keeps the reason its record stored.
  const killedAlone =
    committed.lastError === CORPUS_PROJECTION_OFFLINE_LONE_KILL_MESSAGE;
  if (offlineFinal && revision.observedDocumentCount === 0) {
    const isolated = deliveredTogether === 1;
    return {
      type: "withdraw",
      intent: committed,
      message: killedAlone
        ? CORPUS_PROJECTION_OFFLINE_LONE_KILL_MESSAGE
        : WITHDRAWN_OFFLINE_APPEND_MESSAGE,
      charge: stillDesired
        ? charge("unknown", isolated ? "document" : "engine")
        : null,
    };
  }
  if (!stillDesired) {
    return { type: "stale", intent: committed };
  }
  if (
    revision.observedDocumentCount !== null &&
    revision.observedDocumentCount > revision.expectedDocumentCount
  ) {
    excess.push(revision);
  }
  const retire = (
    rejection: CorpusIndexError["rejection"],
    message: string,
  ): ProofDecision => ({
    type: "unproven",
    intent: committed,
    message,
    charge: charge(rejection),
  });
  switch (timing.type) {
    case "request_waited":
      return retire("transient", timing.failureMessage);
    case "after_barrier":
      if (committed.appendDelivery === "offline_indexer") {
        return offlineFinal
          ? retire(
              "unknown",
              killedAlone
                ? CORPUS_PROJECTION_OFFLINE_LONE_KILL_MESSAGE
                : UNDELIVERED_OFFLINE_APPEND_MESSAGE,
            )
          : awaitingPublication(committed);
      }
      return transitionAt.getTime() <
        corpusProjectionAcceptedAppendProofDeadline(
          committedBarrierOf(committed),
          manifest,
        ).getTime()
        ? awaitingPublication(committed)
        : retire("unknown", UNPUBLISHED_APPEND_MESSAGE);
    default:
      timing satisfies never;
      return panic(`Unhandled proof timing: ${String(timing)}`);
  }
};

const blockedOutcome = (
  intent: CommittedIntentRow,
  charge: AppendFailureCharge,
): AcceptedCorpusProjectionAppendProof => ({
  status: "blocked",
  intentId: intent.id,
  entityId: intent.entityId,
  kind: charge.kind,
  attempts: charge.failureAttempts,
});

const proofOutcomeOf = (
  decision: ProofDecision,
): AcceptedCorpusProjectionAppendProof => {
  switch (decision.type) {
    case "settled":
      return decision.outcome;
    case "apply":
      return {
        status: "applied",
        intentId: decision.intent.id,
        entityId: decision.intent.entityId,
      };
    case "stale":
      return { status: "stale_cleanup_pending", intentId: decision.intent.id };
    case "unproven":
      return decision.charge.workStatus === "blocked"
        ? blockedOutcome(decision.intent, decision.charge)
        : {
            status: "unproven_cleanup_pending",
            intentId: decision.intent.id,
          };
    case "withdraw":
      return decision.charge?.workStatus === "blocked"
        ? blockedOutcome(decision.intent, decision.charge)
        : { status: "withdrawn", intentId: decision.intent.id };
    default:
      decision satisfies never;
      return panic(`Unhandled proof decision: ${String(decision)}`);
  }
};

/** Act on one exact census of committed revisions of one index. */
export const proveAcceptedCorpusProjectionAppendsTx = async (
  tx: Transaction,
  {
    indexId,
    census: { proofs, unproven },
    timing,
    testNow,
  }: ProveAcceptedCorpusProjectionAppendsOptions,
): Promise<AcceptedCorpusProjectionAppendProof[]> =>
  await settleCommittedCorpusProjectionAppendsTx(tx, {
    indexId,
    proofs,
    unproven,
    timing,
    testNow,
  });

type RetireAcceptedCorpusProjectionAppendsOptions = {
  indexId: string;
  /** Committed revisions no census could count, with the documents written. */
  revisions: readonly {
    revision: ProjectionIntentId;
    documentCount: number;
  }[];
  failureMessage: string;
  testNow?: Date | undefined;
};

/**
 * Retire committed revisions whose census failed right after the request that
 * wrote them, through the same transition as an inexact census.
 */
export const retireAcceptedCorpusProjectionAppendsTx = async (
  tx: Transaction,
  {
    indexId,
    revisions,
    failureMessage,
    testNow,
  }: RetireAcceptedCorpusProjectionAppendsOptions,
): Promise<AcceptedCorpusProjectionAppendProof[]> =>
  await settleCommittedCorpusProjectionAppendsTx(tx, {
    indexId,
    proofs: [],
    unproven: revisions.map(({ revision, documentCount }) => ({
      revision,
      expectedDocumentCount: documentCount,
      observedDocumentCount: null,
    })),
    timing: { type: "request_waited", failureMessage },
    testNow,
  });

type ReadProvableCorpusProjectionAppendsOptions<Family extends CorpusFamily> =
  CorpusProjectionAppendScopedWorkOptions<Family> & {
    generation: string;
    /** The index the previous pass took; this pass takes the next one. */
    afterIndexId: string | null;
    limit: number;
    testNow?: Date | undefined;
  };

/** Not exported, so only a read of the database clock constructs one. */
const CENSUS_START_CONSTRUCTION: unique symbol = Symbol(
  "corpus projection census start",
);

/**
 * A PostgreSQL clock reading taken before a census was sent, so the census
 * observed the engine no earlier than `at`. An offline revision's count is
 * final only for a census that started once its indexer had certainly ended
 * (`corpusProjectionOfflineIndexerEndedAt`); the instant the proof commits
 * comes after the census and proves nothing about when it looked. The field
 * is private and the constructor gated, so a caller cannot date a census
 * later than the clock it read.
 */
class CorpusProjectionCensusStart {
  readonly #at: Date;

  constructor(construction: typeof CENSUS_START_CONSTRUCTION, at: Date) {
    if (construction !== CENSUS_START_CONSTRUCTION) {
      panic("Corpus projection census start has a foreign constructor");
    }
    if (!Number.isFinite(at.getTime())) {
      panic("Corpus projection census start is not an instant");
    }
    this.#at = at;
  }

  get at() {
    return this.#at;
  }
}

type ProvableCorpusProjectionAppends = {
  indexId: string;
  revisions: { revision: ProjectionIntentId; documentCount: number }[];
  /** Read before the revisions, so before any census of them. */
  censusStart: CorpusProjectionCensusStart;
};

/**
 * The committed revisions of one index whose publish barrier has passed,
 * oldest barrier first, with the document count each append wrote. The index
 * is the first in index order after `afterIndexId` that holds such a
 * revision, wrapping to the first, so passes rotate over the indexes in scope
 * and one whose census keeps failing cannot hold the others back. Plain reads:
 * the proof transaction re-checks each revision under its locks.
 */
export const readProvableCorpusProjectionAppendsTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    family,
    generation,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    afterIndexId,
    limit: requestedLimit,
    testNow,
  }: ReadProvableCorpusProjectionAppendsOptions<Family>,
): Promise<ProvableCorpusProjectionAppends | null> => {
  const limit = validateBatchSize(requestedLimit);
  const manifest = requireCorpusIndexManifest(family, generation);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  const scopedIndexId = indexIdForCorpusProjectionWorkScope(scope, manifest);
  const censusStart = new CorpusProjectionCensusStart(
    CENSUS_START_CONSTRUCTION,
    testNow ?? (await readPostgresClock(tx)),
  );
  const now = testNow ?? sql<Date>`clock_timestamp()`;
  const provable = (indexId: string | null) =>
    and(
      eq(corpusIndexProjectionIntents.family, family),
      eq(corpusIndexProjectionIntents.generation, generation),
      indexId === null
        ? undefined
        : eq(corpusIndexProjectionIntents.indexId, indexId),
      scopedEntityIds === null
        ? undefined
        : inArray(corpusIndexProjectionIntents.entityId, scopedEntityIds),
      eq(corpusIndexProjectionIntents.status, "append_committed"),
      sql`${corpusIndexProjectionIntents.appendPublishBarrierAt} <= ${now}::timestamptz`,
    );
  const firstIndexAfter = async (after: string | null) =>
    (
      await tx
        .select({ indexId: corpusIndexProjectionIntents.indexId })
        .from(corpusIndexProjectionIntents)
        .where(
          and(
            provable(scopedIndexId),
            after === null
              ? undefined
              : gt(corpusIndexProjectionIntents.indexId, after),
          ),
        )
        .orderBy(asc(corpusIndexProjectionIntents.indexId))
        .limit(1)
    ).at(0);
  const next =
    (await firstIndexAfter(afterIndexId)) ??
    (afterIndexId === null ? undefined : await firstIndexAfter(null));
  if (next === undefined) {
    return null;
  }
  const rows = await tx
    .select({
      revision: corpusIndexProjectionIntents.id,
      documentCount: corpusIndexProjectionIntents.expectedDocumentCount,
    })
    .from(corpusIndexProjectionIntents)
    .where(provable(next.indexId))
    .orderBy(
      asc(corpusIndexProjectionIntents.appendPublishBarrierAt),
      asc(corpusIndexProjectionIntents.id),
    )
    .limit(limit);
  return {
    indexId: next.indexId,
    revisions: rows.map(({ revision, documentCount }) => ({
      revision,
      documentCount:
        documentCount ??
        panic(`Committed projection intent has no document count: ${revision}`),
    })),
    censusStart,
  };
};

type ReadCommittedCorpusProjectionRevisionsOptions = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  /** The revisions a caller wrote and wants decided, at most one census. */
  revisions: readonly ProjectionIntentId[];
  testNow?: Date | undefined;
};

export type CommittedCorpusProjectionRevisions = {
  /** Committed and past their barrier: what one census may decide now. */
  provable: { revision: ProjectionIntentId; documentCount: number }[];
  /** Committed, with a barrier still ahead. */
  unpublished: ProjectionIntentId[];
  /** No longer committed: decided, erased or recovered by another actor. */
  settled: ProjectionIntentId[];
  /** Read before the revisions, so before any census of them. */
  censusStart: CorpusProjectionCensusStart;
};

/**
 * The state of revisions a caller names, for a proof of exactly those: the
 * offline build proves the revisions it delivered rather than whichever the
 * index's oldest barriers name. Plain reads, like the proof cycle's: the
 * proof transaction re-checks each revision under its locks.
 */
export const readCommittedCorpusProjectionRevisionsTx = async (
  tx: Transaction,
  {
    family,
    generation,
    indexId,
    revisions,
    testNow,
  }: ReadCommittedCorpusProjectionRevisionsOptions,
): Promise<CommittedCorpusProjectionRevisions> => {
  if (
    revisions.length === 0 ||
    revisions.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS ||
    new Set(revisions).size !== revisions.length
  ) {
    return panic(
      `A committed revision read must name 1 to ${CORPUS_PROJECTION_DELETE_MAX_REVISIONS} unique revisions`,
    );
  }
  const censusStart = new CorpusProjectionCensusStart(
    CENSUS_START_CONSTRUCTION,
    testNow ?? (await readPostgresClock(tx)),
  );
  const rows = await tx
    .select({
      revision: corpusIndexProjectionIntents.id,
      documentCount: corpusIndexProjectionIntents.expectedDocumentCount,
      published: sql<boolean>`${corpusIndexProjectionIntents.appendPublishBarrierAt} <= ${censusStart.at}::timestamptz`,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, [...revisions]),
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        eq(corpusIndexProjectionIntents.status, "append_committed"),
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(revisions.length);
  const committed = new Set(rows.map(({ revision }) => revision));
  return {
    provable: rows
      .filter(({ published }) => published)
      .map(({ revision, documentCount }) => ({
        revision,
        documentCount:
          documentCount ??
          panic(
            `Committed projection intent has no document count: ${revision}`,
          ),
      })),
    unpublished: rows
      .filter(({ published }) => !published)
      .map(({ revision }) => revision),
    settled: revisions.filter((revision) => !committed.has(revision)),
    censusStart,
  };
};

type ProofTransition = Exclude<ProofDecision, { type: "settled" }>;

type WriteCorpusProjectionProofTransitionsOptions = {
  manifest: CorpusIndexManifest;
  transitions: readonly ProofTransition[];
  transitionAt: Date;
};

const STALE_PROOF_MESSAGE =
  "projection desired state changed while its append awaited proof";

/**
 * Write every revision one proof decided, in one statement: a proven revision
 * becomes applied, a stale or unproven one goes to cleanup behind the
 * barrier it stored. Then the authoritative state of each applied entity and
 * the retry of each unproven one, under the charge its timing decides; the
 * retry writes a new revision, so a late publication of the old one is a
 * survivor cleanup deletes. The caller holds the state and
 * intent locks and checked every desired state.
 */
const writeCorpusProjectionProofTransitionsTx = async (
  tx: Transaction,
  {
    manifest,
    transitions,
    transitionAt,
  }: WriteCorpusProjectionProofTransitionsOptions,
): Promise<void> => {
  // audit: skip - proof bookkeeping on the derived public corpus projection
  const byIntent = (
    value: (transition: ProofTransition) => SQL | null,
    fallback: SQL,
  ) =>
    sqlCaseFragment({
      operand: sql`${corpusIndexProjectionIntents.id}`,
      branches: transitions.flatMap((transition) => {
        const branch = value(transition);
        return branch === null
          ? []
          : [sql`WHEN ${transition.intent.id}::uuid THEN ${branch}`];
      }),
      fallback,
    });
  const { cleanupNotBefore } = corpusProjectionAcceptedAppendCleanupFence(
    manifest,
    transitionAt,
  );
  const statusOf = (kind: ProofTransition["type"]): CorpusIndexIntentStatus => {
    switch (kind) {
      case "apply":
        return APPLIED_STATUS;
      case "withdraw":
        return WITHDRAWN_STATUS;
      case "stale":
      case "unproven":
        return CLEANUP_PENDING_STATUS;
      default:
        kind satisfies never;
        return panic(`Unhandled proof transition: ${String(kind)}`);
    }
  };
  const written = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: byIntent(
        ({ type }) => sql`${statusOf(type)}`,
        sql`${corpusIndexProjectionIntents.status}`,
      ),
      appliedAt: byIntent(
        ({ type }) => (type === "apply" ? sql`${transitionAt}` : null),
        sql`${corpusIndexProjectionIntents.appliedAt}`,
      ),
      cleanupNotBefore: byIntent(
        ({ type }) =>
          statusOf(type) === CLEANUP_PENDING_STATUS ? cleanupNotBefore : null,
        sql`${corpusIndexProjectionIntents.cleanupNotBefore}`,
      ),
      lastError: byIntent(
        (transition) => {
          switch (transition.type) {
            case "apply":
              return null;
            case "stale":
              return sql`${STALE_PROOF_MESSAGE}`;
            case "unproven":
            case "withdraw":
              return sql`${transition.message}`;
            default:
              transition satisfies never;
              return panic(`Unhandled proof transition: ${String(transition)}`);
          }
        },
        sql`${corpusIndexProjectionIntents.lastError}`,
      ),
      updatedAt: transitionAt,
    })
    .where(
      and(
        inArray(
          corpusIndexProjectionIntents.id,
          transitions.map(({ intent }) => intent.id),
        ),
        eq(corpusIndexProjectionIntents.status, "append_committed"),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (written.length !== transitions.length) {
    return panic(
      `Projection proof wrote ${written.length} of ${transitions.length} locked revisions`,
    );
  }
  const applied = transitions.flatMap(({ type, intent }) =>
    type === "apply" ? [intent.id] : [],
  );
  if (applied.length > 0) {
    const appliedStates = await tx
      .update(corpusIndexProjectionStates)
      .set({
        appliedAction: "upsert",
        appliedEpoch: sql`${corpusIndexProjectionIntents.epoch}`,
        appliedRevision: sql`${corpusIndexProjectionIntents.id}`,
        appliedFingerprint: sql`${corpusIndexProjectionIntents.fingerprint}`,
        appliedIndexId: sql`${corpusIndexProjectionIntents.indexId}`,
        appliedAt: transitionAt,
        workStatus: "eligible",
        retryNotBefore: null,
        failureAttempts: 0,
        appendMode: "batchable",
        lastFailureKind: null,
        lastFailureMessage: null,
        updatedAt: transitionAt,
      })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          inArray(corpusIndexProjectionIntents.id, applied),
          eq(
            corpusIndexProjectionStates.family,
            corpusIndexProjectionIntents.family,
          ),
          eq(
            corpusIndexProjectionStates.generation,
            corpusIndexProjectionIntents.generation,
          ),
          eq(
            corpusIndexProjectionStates.entityId,
            corpusIndexProjectionIntents.entityId,
          ),
          eq(corpusIndexProjectionStates.desiredAction, "upsert"),
          eq(
            corpusIndexProjectionStates.desiredEpoch,
            corpusIndexProjectionIntents.epoch,
          ),
          eq(
            corpusIndexProjectionStates.desiredFingerprint,
            corpusIndexProjectionIntents.fingerprint,
          ),
          eq(
            corpusIndexProjectionStates.desiredIndexId,
            corpusIndexProjectionIntents.indexId,
          ),
        ),
      )
      .returning({ entityId: corpusIndexProjectionStates.entityId });
    if (appliedStates.length !== applied.length) {
      return panic(
        `Projection proof CAS applied ${appliedStates.length} of ${applied.length} locked states`,
      );
    }
  }
  await chargeGivenUpRevisionsTx(tx, { transitions, transitionAt });
};

type ChargedProofTransition = {
  intent: ProofTransition["intent"];
  charge: AppendFailureCharge;
  message: string;
};

/**
 * Schedule the retry of each entity whose revision this proof retired or
 * withdrew while the entity still wants it, under the charge its decision
 * carries; one withdrawn for an entity that moved on has nothing to retry.
 * The retry writes a new revision, so a late publication of the old one is a
 * survivor cleanup deletes.
 */
const chargeGivenUpRevisionsTx = async (
  tx: Transaction,
  {
    transitions,
    transitionAt,
  }: Omit<WriteCorpusProjectionProofTransitionsOptions, "manifest">,
): Promise<void> => {
  // audit: skip - proof bookkeeping on the derived public corpus projection
  const unproven = transitions.flatMap(
    (transition): ChargedProofTransition[] => {
      switch (transition.type) {
        case "unproven":
          return [transition];
        case "withdraw":
          return transition.charge === null
            ? []
            : [{ ...transition, charge: transition.charge }];
        case "apply":
        case "stale":
          return [];
        default:
          transition satisfies never;
          return panic(`Unhandled proof transition: ${String(transition)}`);
      }
    },
  );
  if (unproven.length === 0) {
    return;
  }
  const byEntity = (
    value: (charge: AppendFailureCharge) => string | number | Date | null,
    cast: string,
  ) =>
    sqlCaseFragment({
      operand: sql`${corpusIndexProjectionStates.entityId}`,
      branches: unproven.map(
        ({ intent, charge }) =>
          sql`WHEN ${intent.entityId}::uuid THEN ${value(charge)}${sql.raw(`::${cast}`)}`,
      ),
      fallback: sql`NULL`,
    });
  const { family, generation } =
    unproven.at(0)?.intent ?? panic("No unproven projection appends");
  const charged = await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: byEntity(({ workStatus }) => workStatus, "text"),
      retryNotBefore: byEntity(
        ({ retryNotBefore }) => retryNotBefore,
        "timestamptz",
      ),
      failureAttempts: byEntity(
        ({ failureAttempts }) => failureAttempts,
        "integer",
      ),
      appendMode: byEntity(({ appendMode }) => appendMode, "text"),
      lastFailureKind: byEntity(({ kind }) => kind, "text"),
      lastFailureMessage: sqlCaseFragment({
        operand: sql`${corpusIndexProjectionStates.entityId}`,
        branches: unproven.map(
          ({ intent, message }) =>
            sql`WHEN ${intent.entityId}::uuid THEN ${message.slice(0, 2048)}`,
        ),
        fallback: sql`${corpusIndexProjectionStates.lastFailureMessage}`,
      }),
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        inArray(
          corpusIndexProjectionStates.entityId,
          unproven.map(({ intent }) => intent.entityId),
        ),
      ),
    )
    .returning({ entityId: corpusIndexProjectionStates.entityId });
  if (charged.length !== unproven.length) {
    return panic(
      `Unproven projection charge matched ${charged.length} of ${unproven.length} states`,
    );
  }
};

type CancelCorpusProjectionReservationsOptions = {
  /** Reservations of one generation, at most one store batch. */
  leases: readonly Pick<
    CorpusProjectionIntentLease,
    "intentId" | "leaseToken" | "family" | "generation"
  >[];
  errorMessage: string;
  testNow?: Date | undefined;
};

/**
 * Cancel many reservations of one generation in one statement, under the
 * same locks the single-row cancel takes: the generation's mutation lock,
 * then the intent rows in id order. A reservation whose lease moved on is
 * counted as lost, not touched.
 */
export const cancelCorpusProjectionReservationsTx = async (
  tx: Transaction,
  { leases, errorMessage, testNow }: CancelCorpusProjectionReservationsOptions,
): Promise<{ cancelled: number; leaseLost: number }> => {
  // audit: skip - reservation bookkeeping on the derived public corpus projection
  const first = leases.at(0);
  if (first === undefined) {
    return { cancelled: 0, leaseLost: 0 };
  }
  if (
    leases.length > CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE ||
    leases.some(
      ({ family, generation }) =>
        family !== first.family || generation !== first.generation,
    ) ||
    new Set(leases.map(({ intentId }) => intentId)).size !== leases.length
  ) {
    return panic(
      "A reservation cancel names one generation's unique leases, at most one store batch",
    );
  }
  await lockCorpusIndexProjectionMutationsTx(tx, [first]);
  await lockCorpusProjectionIntentsById(
    tx,
    leases.map(({ intentId }) => intentId),
  );
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const leased = sql.join(
    leases.map(
      ({ intentId, leaseToken }) => sql`(${intentId}::uuid, ${leaseToken})`,
    ),
    sql`, `,
  );
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cancelled",
      leaseToken: null,
      leaseExpiresAt: null,
      cancelledAt: transitionAt,
      lastError: errorMessage.slice(0, 2048),
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionIntents.status, "reserved"),
        sql`(${corpusIndexProjectionIntents.id}, ${corpusIndexProjectionIntents.leaseToken}) IN (${leased})`,
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  return { cancelled: rows.length, leaseLost: leases.length - rows.length };
};

export type CorpusProjectionReservationFailure =
  | {
      status: "retry_scheduled";
      kind: CorpusIndexProjectionFailureKind;
      retryDelayMs: number;
      maxAttempts: number;
      message: string;
    }
  | {
      status: "blocked";
      kind: CorpusIndexProjectionFailureKind;
      message: string;
    };

type ClassifyCorpusProjectionReservationFailureOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  failure: CorpusProjectionReservationFailure;
  testNow?: Date;
};

export const CORPUS_PROJECTION_RETRY_MIN_MS = 1000;
export const CORPUS_PROJECTION_RETRY_MAX_MS = 7 * 24 * 60 * 60_000;
export const CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN = 1;
export const CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX = 100;

export type CorpusProjectionReservationFailureResult =
  "retry_scheduled" | "blocked" | "stale_cancelled" | "lease_lost";

/**
 * Finish one unattempted revision and durably move its exact desired state out
 * of the eligible queue. A newer desired epoch resets this classification.
 */
export const classifyCorpusProjectionReservationFailureTx = async (
  tx: Transaction,
  {
    intentId,
    leaseToken,
    failure,
    testNow,
  }: ClassifyCorpusProjectionReservationFailureOptions,
): Promise<CorpusProjectionReservationFailureResult> => {
  if (
    failure.status === "retry_scheduled" &&
    (!Number.isSafeInteger(failure.retryDelayMs) ||
      failure.retryDelayMs < CORPUS_PROJECTION_RETRY_MIN_MS ||
      failure.retryDelayMs > CORPUS_PROJECTION_RETRY_MAX_MS)
  ) {
    return panic(
      `Corpus projection retry delay must be an integer from ${CORPUS_PROJECTION_RETRY_MIN_MS} to ${CORPUS_PROJECTION_RETRY_MAX_MS} milliseconds`,
    );
  }
  if (
    failure.status === "retry_scheduled" &&
    (!Number.isSafeInteger(failure.maxAttempts) ||
      failure.maxAttempts < CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN ||
      failure.maxAttempts > CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX)
  ) {
    return panic(
      `Corpus projection retry attempt limit must be an integer from ${CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN} to ${CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX}`,
    );
  }
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
      epoch: corpusIndexProjectionIntents.epoch,
      fingerprint: corpusIndexProjectionIntents.fingerprint,
      indexId: corpusIndexProjectionIntents.indexId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .limit(1);
  const identity = identities.at(0);
  if (identity === undefined) {
    return "lease_lost";
  }
  await lockCorpusIndexProjectionMutationsTx(tx, [identity]);
  const { state, intent } = await lockProjectionFailureRowsTx(tx, {
    ...identity,
    intentId,
    leaseToken,
    status: "reserved",
  });
  if (intent === undefined) {
    return "lease_lost";
  }
  const transitionAt = testNow ?? (await readPostgresClock(tx));
  await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cancelled",
      leaseToken: null,
      leaseExpiresAt: null,
      cancelledAt: transitionAt,
      lastError: failure.message.slice(0, 2048),
      updatedAt: transitionAt,
    })
    .where(eq(corpusIndexProjectionIntents.id, intentId));
  if (!isStillDesiredProjection(state, intent)) {
    return "stale_cancelled";
  }
  const nextFailureAttempts = sql<number>`${corpusIndexProjectionStates.failureAttempts} + 1`;
  const retryExhausted =
    failure.status === "retry_scheduled"
      ? sql<boolean>`${nextFailureAttempts} >= ${failure.maxAttempts}`
      : sql<boolean>`true`;
  const nextWorkStatus = sql<"retry_scheduled" | "blocked">`CASE
    WHEN ${retryExhausted} THEN 'blocked'
    ELSE 'retry_scheduled'
  END`;
  const retryAt =
    failure.status === "retry_scheduled"
      ? new Date(transitionAt.getTime() + failure.retryDelayMs)
      : null;
  const retryNotBefore = sql<Date | null>`CASE
    WHEN ${retryExhausted} THEN NULL::timestamptz
    ELSE ${retryAt}::timestamptz
  END`;
  const updatedStates = await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: nextWorkStatus,
      retryNotBefore,
      failureAttempts: nextFailureAttempts,
      lastFailureKind: failure.kind,
      lastFailureMessage: failure.message.slice(0, 2048),
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, intent.family),
        eq(corpusIndexProjectionStates.generation, intent.generation),
        eq(corpusIndexProjectionStates.entityId, intent.entityId),
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        eq(corpusIndexProjectionStates.desiredEpoch, intent.epoch),
        eq(corpusIndexProjectionStates.desiredFingerprint, intent.fingerprint),
        eq(corpusIndexProjectionStates.desiredIndexId, intent.indexId),
      ),
    )
    .returning({ workStatus: corpusIndexProjectionStates.workStatus });
  const workStatus = updatedStates.at(0)?.workStatus;
  switch (workStatus) {
    case "retry_scheduled":
    case "blocked":
      return workStatus;
    case undefined:
      return "stale_cancelled";
    case "eligible":
    case "repair_scheduled":
      return panic(
        `Projection failure classification returned ${workStatus} work`,
      );
    default:
      workStatus satisfies never;
      return panic(`Unhandled work status: ${String(workStatus)}`);
  }
};
