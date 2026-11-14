import { panic } from "better-result";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { backoffDelay } from "@stll/concurrency/backoff-delay";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  corpusProjectionReservationQueue,
  lockCorpusProjectionAcceptedRows,
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
  type CorpusProjectionPresenceCensus,
  type CorpusProjectionPresenceProof,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  corpusProjectionAcceptedAppendCleanupFence,
  corpusProjectionAcceptedAppendProofDeadline,
  corpusProjectionAppendPublishBarrier,
  corpusProjectionUnrecordedAppendCleanupFence,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import { lockCorpusIndexProjectionMutationsTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
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

const corpusProjectionStateQueueOrder = () => [
  asc(corpusIndexProjectionStates.updatedAt),
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
 * entity is terminal. This enforces delete-old, settle, then append-new; the
 * operator controls how often and how broadly this bounded primitive runs.
 */
export const reserveCorpusProjectionIntentsTx = async <
  Family extends CorpusFamily,
>(
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
): Promise<CorpusProjectionIntentLease[]> => {
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
    return [];
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
  });

  if (candidates.length === 0) {
    return [];
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
  return leases;
};

export type CorpusProjectionReplacementCleanup = {
  intentId: ProjectionIntentId;
  family: CorpusFamily;
  generation: string;
  entityId: string;
  indexId: string;
};

type PrepareCorpusProjectionReplacementsOptions<Family extends CorpusFamily> =
  CorpusProjectionAppendScopedWorkOptions<Family> & {
    generation: string;
    limit: number;
    testNow?: Date;
  };

/**
 * Move current but superseded revisions to cleanup before a replacement can
 * be reserved. Applied revisions are known published, so no unknown-append
 * delay is needed; delete settlement remains mandatory.
 */
export const prepareCorpusProjectionReplacementsTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    family,
    generation,
    limit: requestedLimit,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    testNow,
  }: PrepareCorpusProjectionReplacementsOptions<Family>,
): Promise<CorpusProjectionReplacementCleanup[]> => {
  const limit = validateBatchSize(requestedLimit);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  const manifest = await lockActiveCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const scopedIndexId = indexIdForCorpusProjectionWorkScope(scope, manifest);
  const candidates = await tx
    .select({
      intentId: corpusIndexProjectionStates.appliedRevision,
      entityId: corpusIndexProjectionStates.entityId,
      indexId: corpusIndexProjectionStates.appliedIndexId,
    })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        scopedEntityIds === null
          ? undefined
          : inArray(corpusIndexProjectionStates.entityId, scopedEntityIds),
        scopedIndexId === null
          ? undefined
          : eq(corpusIndexProjectionStates.desiredIndexId, scopedIndexId),
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        eq(corpusIndexProjectionStates.appliedAction, "upsert"),
        isNotNull(corpusIndexProjectionStates.appliedRevision),
        isNotNull(corpusIndexProjectionStates.appliedIndexId),
        sql`${corpusIndexProjectionStates.desiredEpoch} > ${corpusIndexProjectionStates.appliedEpoch}`,
      ),
    )
    .orderBy(...corpusProjectionStateQueueOrder())
    .limit(limit)
    .for("update", {
      of: corpusIndexProjectionStates,
      skipLocked: true,
    });
  if (candidates.length === 0) {
    return [];
  }
  const cleanups = candidates.map((candidate) => {
    if (candidate.intentId === null || candidate.indexId === null) {
      return panic(
        `Applied projection state is missing its exact revision: ${family}/${generation}/${candidate.entityId}`,
      );
    }
    return {
      intentId: candidate.intentId,
      family,
      generation,
      entityId: candidate.entityId,
      indexId: candidate.indexId,
    } satisfies CorpusProjectionReplacementCleanup;
  });
  const intentIds = cleanups.map(({ intentId }) => intentId);
  await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, intentIds))
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(limit)
    .for("update");
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  // Rotate every inspected row to the pending queue's tail. A revision that
  // cleanup already owns can then reduce this batch's result, but it cannot
  // leave a fixed old prefix that hides later replacements.
  await tx
    .update(corpusIndexProjectionStates)
    .set({ updatedAt: transitionAt })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        inArray(
          corpusIndexProjectionStates.entityId,
          cleanups.map(({ entityId }) => entityId),
        ),
      ),
    );
  const updated = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      ...corpusProjectionAcceptedAppendCleanupFence(manifest, transitionAt),
      lastError: null,
      updatedAt: transitionAt,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.status, "applied"),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  const updatedIds = new Set(updated.map(({ id }) => id));
  return cleanups.filter(({ intentId }) => updatedIds.has(intentId));
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
  testNow?: Date;
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
): Promise<CorpusProjectionAppendStart[]> => {
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
  const started = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "append_started",
      appendStartedAt: transitionAt,
      appendRequestRevisionCount: leases.length,
      updatedAt: transitionAt,
    })
    .where(
      and(
        exactLeases,
        eq(corpusIndexProjectionIntents.family, first.family),
        eq(corpusIndexProjectionIntents.generation, first.generation),
        eq(corpusIndexProjectionIntents.status, "reserved"),
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
  const startedIds = new Set(started.map(({ id }) => id));
  if (started.length > 0 && started.length !== leases.length) {
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
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  const cancelledIds = new Set(cancelled.map(({ id }) => id));
  return leases.map(({ intentId }) => {
    if (startedIds.has(intentId)) {
      return {
        intentId,
        status: "started",
      } satisfies CorpusProjectionAppendStart;
    }
    if (cancelledIds.has(intentId)) {
      return {
        intentId,
        status: "stale_cancelled",
      } satisfies CorpusProjectionAppendStart;
    }
    return {
      intentId,
      status: "lease_lost",
    } satisfies CorpusProjectionAppendStart;
  });
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
    appendRequestRevisionCount: intent.appendRequestRevisionCount,
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

type RecordAcceptedCorpusProjectionAppendsOptions = {
  /** Revisions of one index whose append the engine accepted. */
  accepted: readonly AcceptedProjectionAppend[];
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
 */
export const recordAcceptedCorpusProjectionAppendsTx = async (
  tx: Transaction,
  { accepted, testNow }: RecordAcceptedCorpusProjectionAppendsOptions,
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
    return isStillDesiredProjection(rows.states.get(intent.entityId), intent)
      ? ({ status: "accepted", intentId, documentCount } as const)
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
        appendPublishBarrierAt: fence.appendPublishBarrierAt,
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
          sql`${corpusIndexProjectionIntents.lastError}`,
        ),
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
 * - `request_waited`: the executor, right after a request that waited for
 *   publication. An exact count applies at once; an inexact one retires the
 *   revision at once with an uncharged retry, as a transient append failure.
 */
export type CorpusProjectionProofTiming =
  | { type: "after_barrier" }
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
  /** Every outcome that does not depend on the census, or null to use it. */
  const precedingDecision = (
    intentId: ProjectionIntentId,
    intent: typeof corpusIndexProjectionIntents.$inferSelect | undefined,
  ): ProofDecision | null => {
    if (intent === undefined) {
      return {
        type: "settled",
        outcome: { status: "not_accepted", intentId },
      };
    }
    const state = states.get(intent.entityId);
    if (intent.status === "applied" && state?.appliedRevision === intent.id) {
      return {
        type: "settled",
        outcome: { status: "already_applied", intentId },
      };
    }
    if (intent.status !== "append_committed" || intent.leaseToken !== null) {
      return {
        type: "settled",
        outcome: { status: "not_accepted", intentId },
      };
    }
    return isStillDesiredProjection(state, intent)
      ? null
      : { type: "stale", intent };
  };
  const barrierOf = (
    intent: typeof corpusIndexProjectionIntents.$inferSelect,
  ) =>
    intent.appendPublishBarrierAt ??
    panic(`Committed projection intent has no barrier: ${intent.id}`);
  const excess: UnprovenCommittedRevision[] = [];
  const decisions: ProofDecision[] = [
    ...proofs.map((proof): ProofDecision => {
      const intent = locked(proof.revision, proof.documentCount);
      const preceding = precedingDecision(proof.revision, intent);
      if (preceding !== null) {
        return preceding;
      }
      const committed = intent ?? panic(`Lost proven intent ${proof.revision}`);
      switch (timing.type) {
        case "request_waited":
          return { type: "apply", intent: committed };
        case "after_barrier":
          return transitionAt.getTime() < barrierOf(committed).getTime()
            ? {
                type: "settled",
                outcome: {
                  status: "awaiting_publication",
                  intentId: committed.id,
                },
              }
            : { type: "apply", intent: committed };
        default:
          timing satisfies never;
          return panic(`Unhandled proof timing: ${String(timing)}`);
      }
    }),
    ...unproven.map((revision): ProofDecision => {
      const intent = locked(revision.revision, revision.expectedDocumentCount);
      const preceding = precedingDecision(revision.revision, intent);
      if (preceding !== null) {
        return preceding;
      }
      const committed =
        intent ?? panic(`Lost unproven intent ${revision.revision}`);
      const state =
        states.get(committed.entityId) ??
        panic(`Committed projection intent has no state: ${committed.id}`);
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
        charge: appendFailureCharge({
          state,
          appendRequestRevisionCount: committed.appendRequestRevisionCount,
          transitionAt,
          rejection,
          fault: "document",
        }),
      });
      switch (timing.type) {
        case "request_waited":
          return retire("transient", timing.failureMessage);
        case "after_barrier":
          return transitionAt.getTime() <
            corpusProjectionAcceptedAppendProofDeadline(
              barrierOf(committed),
              manifest,
            ).getTime()
            ? {
                type: "settled",
                outcome: {
                  status: "awaiting_publication",
                  intentId: committed.id,
                },
              }
            : retire("unknown", UNPUBLISHED_APPEND_MESSAGE);
        default:
          timing satisfies never;
          return panic(`Unhandled proof timing: ${String(timing)}`);
      }
    }),
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

  return decisions.map((decision): AcceptedCorpusProjectionAppendProof => {
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
        return {
          status: "stale_cleanup_pending",
          intentId: decision.intent.id,
        };
      case "unproven":
        return decision.charge.workStatus === "blocked"
          ? {
              status: "blocked",
              intentId: decision.intent.id,
              entityId: decision.intent.entityId,
              kind: decision.charge.kind,
              attempts: decision.charge.failureAttempts,
            }
          : {
              status: "unproven_cleanup_pending",
              intentId: decision.intent.id,
            };
      default:
        decision satisfies never;
        return panic(`Unhandled proof decision: ${String(decision)}`);
    }
  });
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
    limit: number;
    testNow?: Date | undefined;
  };

type ProvableCorpusProjectionAppends = {
  indexId: string;
  revisions: { revision: ProjectionIntentId; documentCount: number }[];
};

/**
 * The committed revisions of one index whose publish barrier has passed:
 * the index holding the oldest such barrier in scope, then its revisions,
 * oldest barrier first, with the document count each append wrote. Plain
 * reads: the proof transaction re-checks each one under its locks.
 */
export const readProvableCorpusProjectionAppendsTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    family,
    generation,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    limit: requestedLimit,
    testNow,
  }: ReadProvableCorpusProjectionAppendsOptions<Family>,
): Promise<ProvableCorpusProjectionAppends | null> => {
  const limit = validateBatchSize(requestedLimit);
  const manifest = requireCorpusIndexManifest(family, generation);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  const scopedIndexId = indexIdForCorpusProjectionWorkScope(scope, manifest);
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
  const oldest = (
    await tx
      .select({ indexId: corpusIndexProjectionIntents.indexId })
      .from(corpusIndexProjectionIntents)
      .where(provable(scopedIndexId))
      .orderBy(asc(corpusIndexProjectionIntents.appendPublishBarrierAt))
      .limit(1)
  ).at(0);
  if (oldest === undefined) {
    return null;
  }
  const rows = await tx
    .select({
      revision: corpusIndexProjectionIntents.id,
      documentCount: corpusIndexProjectionIntents.expectedDocumentCount,
    })
    .from(corpusIndexProjectionIntents)
    .where(provable(oldest.indexId))
    .orderBy(
      asc(corpusIndexProjectionIntents.appendPublishBarrierAt),
      asc(corpusIndexProjectionIntents.id),
    )
    .limit(limit);
  return {
    indexId: oldest.indexId,
    revisions: rows.map(({ revision, documentCount }) => ({
      revision,
      documentCount:
        documentCount ??
        panic(`Committed projection intent has no document count: ${revision}`),
    })),
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
  const written = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: byIntent(
        ({ type }) =>
          type === "apply"
            ? sql`${APPLIED_STATUS}`
            : sql`${CLEANUP_PENDING_STATUS}`,
        sql`${corpusIndexProjectionIntents.status}`,
      ),
      appliedAt: byIntent(
        ({ type }) => (type === "apply" ? sql`${transitionAt}` : null),
        sql`${corpusIndexProjectionIntents.appliedAt}`,
      ),
      cleanupNotBefore: byIntent(
        ({ type }) => (type === "apply" ? null : cleanupNotBefore),
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
  const unproven = transitions.flatMap((transition) =>
    transition.type === "unproven" ? [transition] : [],
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

type CancelCorpusProjectionReservationOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  testNow?: Date;
  errorMessage?: string;
};

export const cancelCorpusProjectionReservationTx = async (
  tx: Transaction,
  {
    intentId,
    leaseToken,
    testNow,
    errorMessage,
  }: CancelCorpusProjectionReservationOptions,
): Promise<"cancelled" | "lease_lost"> => {
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
    })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, intentId))
    .limit(1);
  const identity = identities.at(0);
  if (identity === undefined) {
    return "lease_lost";
  }
  await lockCorpusIndexProjectionMutationsTx(tx, [identity]);
  const locked = await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, intentId))
    .limit(1)
    .for("update");
  if (locked.length === 0) {
    return "lease_lost";
  }
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cancelled",
      leaseToken: null,
      leaseExpiresAt: null,
      cancelledAt: transitionAt,
      lastError: errorMessage?.slice(0, 2048),
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
  return rows.length === 1 ? "cancelled" : "lease_lost";
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
