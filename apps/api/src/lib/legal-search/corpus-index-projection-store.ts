import { panic } from "better-result";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { backoffDelay } from "@stll/concurrency/backoff-delay";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { unattestedCorpusIndexIdsTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_APPEND_CANCEL_REASON,
  type CorpusIndexProjectionAppendMode,
  type CorpusIndexProjectionFailureKind,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  lockActiveCorpusProjectionManifestForMutation,
  lockRegisteredCorpusProjectionManifestForMutation,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
  corpusIndexUnknownAppendBarrierAt,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  corpusProjectionAcceptedAppendCleanupFence,
  corpusProjectionUnrecordedAppendCleanupFence,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import { lockCorpusIndexProjectionMutationsTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  entityIdsForCorpusProjectionWorkScope,
  indexIdForCorpusProjectionWorkScope,
  type CorpusProjectionAppendScopedWorkOptions,
} from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  corpusIndexProjectionIntentIsOutstanding,
  corpusIndexProjectionNeedsWork,
  corpusIndexProjectionProducesAppend,
} from "@/api/lib/legal-search/corpus-index-projection-sql";

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

const pendingDesiredState = corpusIndexProjectionNeedsWork(
  corpusIndexProjectionStates,
);

const noOutstandingIntent = sql`NOT EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionIntents} outstanding
      WHERE outstanding.family = ${corpusIndexProjectionStates.family}
        AND outstanding.generation = ${corpusIndexProjectionStates.generation}
        AND outstanding.entity_id = ${corpusIndexProjectionStates.entityId}
        AND ${corpusIndexProjectionIntentIsOutstanding(sql`outstanding.status`)}
    )`;

type CorpusProjectionReservationQueueOptions = {
  family: CorpusFamily;
  generation: string;
  limit: number;
  eligibilityAt: Date;
  scopedEntityIds: readonly string[] | null;
  scopedIndexId: string | null;
  /** Physical indexes no append may reach yet (`unattestedCorpusIndexIdsTx`). */
  excludedIndexIds: readonly string[];
};

/**
 * The reservation queue read. Exported so the plan guard explains the exact
 * statement the append cycle issues rather than a copy of it.
 */
export const corpusProjectionReservationQueue = (
  tx: Transaction,
  {
    family,
    generation,
    limit,
    eligibilityAt,
    scopedEntityIds,
    scopedIndexId,
    excludedIndexIds,
  }: CorpusProjectionReservationQueueOptions,
) => {
  const runnableAt = sql<Date>`coalesce(
    ${corpusIndexProjectionStates.retryNotBefore},
    ${corpusIndexProjectionStates.updatedAt}
  )`;
  return tx
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      epoch: corpusIndexProjectionStates.desiredEpoch,
      fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      indexId: corpusIndexProjectionStates.desiredIndexId,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
      lastFailureKind: corpusIndexProjectionStates.lastFailureKind,
      appendMode: corpusIndexProjectionStates.appendMode,
    })
    .from(corpusIndexProjectionStates)
    .innerJoin(
      corpusIndexGenerations,
      and(
        eq(corpusIndexGenerations.family, corpusIndexProjectionStates.family),
        eq(
          corpusIndexGenerations.generation,
          corpusIndexProjectionStates.generation,
        ),
      ),
    )
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
        // An unattested group's desired state stays eligible and waits here:
        // it is appended once the group is attested, never before.
        excludedIndexIds.length === 0
          ? undefined
          : notInArray(corpusIndexProjectionStates.desiredIndexId, [
              ...excludedIndexIds,
            ]),
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        inArray(corpusIndexProjectionStates.workStatus, [
          "eligible",
          "retry_scheduled",
          "repair_scheduled",
        ]),
        lte(runnableAt, eligibilityAt),
        inArray(corpusIndexGenerations.status, ["building", "serving"]),
        pendingDesiredState,
        noOutstandingIntent,
      ),
    )
    .orderBy(asc(runnableAt), asc(corpusIndexProjectionStates.entityId))
    .limit(limit)
    .for("update", {
      of: corpusIndexProjectionStates,
      skipLocked: true,
    });
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

type AbandonCorpusProjectionAppendOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  testNow?: Date;
  errorMessage: string;
  rejection?: CorpusIndexError["rejection"];
  fault?: "document" | "engine";
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
  const barrier = corpusIndexUnknownAppendBarrierAt(
    intent.appendStartedAt,
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
  let kind: CorpusIndexProjectionFailureKind = "append_unknown";
  if (rejection === "definite") {
    kind = "append_rejected";
  } else if (rejection === "transient") {
    kind = "append_transient";
  }
  const isolated = intent.appendRequestRevisionCount === 1;
  const documentFault = fault === "document" && rejection !== "transient";
  const charge = documentFault && isolated;
  const failureAttempts = state.failureAttempts + (charge ? 1 : 0);
  let attemptLimit = CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT;
  if (rejection === "definite") {
    attemptLimit = CORPUS_PROJECTION_APPEND_REJECTED_ATTEMPT_LIMIT;
  }
  const blocked = charge && failureAttempts >= attemptLimit;
  const retryDelayMs = backoffDelay(
    Math.min(Math.max(failureAttempts - 1, 0), 6),
    {
      baseMs: CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
      maxMs: CORPUS_PROJECTION_APPEND_RETRY_CAP_MS,
    },
  );
  const updated = await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: blocked ? "blocked" : "retry_scheduled",
      retryNotBefore: blocked
        ? null
        : new Date(transitionAt.getTime() + retryDelayMs),
      failureAttempts,
      appendMode: documentFault && !isolated ? "single" : state.appendMode,
      lastFailureKind: kind,
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
  return blocked
    ? {
        status: "blocked",
        entityId: intent.entityId,
        kind,
        attempts: failureAttempts,
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
  | "unparked"
  | "not_blocked"
  | "cleanup_pending";

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

type CommitCorpusProjectionAppendOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  documentCount: number;
  testNow?: Date;
};

export type CommitCorpusProjectionAppendResult =
  | { status: "applied"; entityId: string }
  | { status: "stale_cleanup_pending"; entityId: string }
  | { status: "lease_lost" };

/**
 * Finalize a published, presence-confirmed append and its authoritative state
 * in one transaction. The executor confirms outside this transaction.
 * A desired-state race cannot publish: the exact new revision is redirected to
 * cleanup instead, behind the barrier that makes that cleanup exact.
 */
export const commitCorpusProjectionAppendTx = async (
  tx: Transaction,
  {
    intentId,
    leaseToken,
    documentCount,
    testNow,
  }: CommitCorpusProjectionAppendOptions,
): Promise<CommitCorpusProjectionAppendResult> => {
  if (!Number.isSafeInteger(documentCount) || documentCount < 1) {
    return panic("Projection append document count must be a positive integer");
  }
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, intentId))
    .limit(1);
  const identity = identities.at(0);
  if (identity === undefined) {
    return { status: "lease_lost" };
  }
  const manifest = await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    identity.family,
    identity.generation,
  );
  const states = await tx
    .select()
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
  const state = states.at(0);
  const intents = await tx
    .select()
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, intentId))
    .limit(1)
    .for("update");
  const intent = intents.at(0);
  if (intent === undefined) {
    return { status: "lease_lost" };
  }
  if (
    intent.expectedDocumentCount !== null &&
    intent.expectedDocumentCount !== documentCount
  ) {
    return panic(`Projection append document count changed: ${intent.id}`);
  }
  if (intent.status === "applied" && state?.appliedRevision === intent.id) {
    return { status: "applied", entityId: intent.entityId };
  }
  if (
    state === undefined ||
    intent.leaseToken !== leaseToken ||
    (intent.status !== "append_started" && intent.status !== "append_committed")
  ) {
    return { status: "lease_lost" };
  }

  const stillDesired =
    state.desiredAction === "upsert" &&
    state.desiredEpoch === intent.epoch &&
    state.desiredFingerprint === intent.fingerprint &&
    state.desiredIndexId === intent.indexId;
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  if (!stillDesired) {
    if (intent.appendStartedAt === null) {
      return panic(`Started projection intent has no start time: ${intent.id}`);
    }
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cleanup_pending",
        leaseToken: null,
        leaseExpiresAt: null,
        ...(intent.appendCommittedAt === null
          ? corpusProjectionUnrecordedAppendCleanupFence(manifest, transitionAt)
          : corpusProjectionAcceptedAppendCleanupFence(manifest, transitionAt)),
        expectedDocumentCount: documentCount,
        lastError: "projection desired state changed after append committed",
        updatedAt: transitionAt,
      })
      .where(eq(corpusIndexProjectionIntents.id, intent.id));
    return {
      status: "stale_cleanup_pending",
      entityId: intent.entityId,
    };
  }

  if (intent.status === "append_started") {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "append_committed",
        appendCommittedAt: transitionAt,
        expectedDocumentCount: documentCount,
        updatedAt: transitionAt,
      })
      .where(eq(corpusIndexProjectionIntents.id, intent.id));
  }
  await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "applied",
      leaseToken: null,
      leaseExpiresAt: null,
      appliedAt: transitionAt,
      updatedAt: transitionAt,
    })
    .where(eq(corpusIndexProjectionIntents.id, intent.id));
  const applied = await tx
    .update(corpusIndexProjectionStates)
    .set({
      appliedAction: "upsert",
      appliedEpoch: intent.epoch,
      appliedRevision: intent.id,
      appliedFingerprint: intent.fingerprint,
      appliedIndexId: intent.indexId,
      appliedAt: transitionAt,
      workStatus: "eligible",
      retryNotBefore: null,
      failureAttempts: 0,
      appendMode: "batchable",
      lastFailureKind: null,
      lastFailureMessage: null,
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
  if (applied.length !== 1) {
    return panic(
      `Projection append CAS failed after locking state: ${intent.id}`,
    );
  }
  return { status: "applied", entityId: intent.entityId };
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
  | "retry_scheduled"
  | "blocked"
  | "stale_cancelled"
  | "lease_lost";

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
