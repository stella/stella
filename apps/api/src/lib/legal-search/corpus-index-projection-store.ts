import { panic } from "better-result";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  readActiveCorpusProjectionManifest,
  readRegisteredCorpusProjectionManifestForCleanup,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
  corpusIndexUnknownAppendBarrierAt,
} from "@/api/lib/legal-search/corpus-index-projection-engine";

export const CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE =
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS;
export const CORPUS_PROJECTION_LEASE_MIN_MS = 5_000;
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
};

type ReserveCorpusProjectionIntentsOptions = {
  family: CorpusFamily;
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

const pendingDesiredState = sql`(
  ${corpusIndexProjectionStates.appliedAction} IS NULL
  OR ${corpusIndexProjectionStates.appliedAction} IS DISTINCT FROM ${corpusIndexProjectionStates.desiredAction}
  OR ${corpusIndexProjectionStates.appliedEpoch} IS DISTINCT FROM ${corpusIndexProjectionStates.desiredEpoch}
  OR ${corpusIndexProjectionStates.appliedFingerprint} IS DISTINCT FROM ${corpusIndexProjectionStates.desiredFingerprint}
  OR ${corpusIndexProjectionStates.appliedIndexId} IS DISTINCT FROM ${corpusIndexProjectionStates.desiredIndexId}
)`;

const noOutstandingIntent = sql`NOT EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionIntents} outstanding
      WHERE outstanding.family = ${corpusIndexProjectionStates.family}
        AND outstanding.generation = ${corpusIndexProjectionStates.generation}
        AND outstanding.entity_id = ${corpusIndexProjectionStates.entityId}
        AND outstanding.status NOT IN ('settled', 'cancelled')
    )`;

/**
 * Reserve exact append attempts only after every earlier revision for the
 * entity is terminal. This enforces delete-old, settle, then append-new; Plane
 * controls how often and how broadly this bounded primitive runs.
 */
export const reserveCorpusProjectionIntentsTx = async (
  tx: Transaction,
  {
    family,
    generation,
    limit: requestedLimit,
    leaseMs: requestedLeaseMs,
    testNow,
    newIntentId = () => createSafeId<"corpusIndexProjectionIntent">(),
    newLeaseToken = () => Bun.randomUUIDv7(),
  }: ReserveCorpusProjectionIntentsOptions,
): Promise<CorpusProjectionIntentLease[]> => {
  const limit = validateBatchSize(requestedLimit);
  const leaseMs = validateLeaseMs(requestedLeaseMs);
  await readActiveCorpusProjectionManifest(tx, family, generation, true);

  const candidates = await tx
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      epoch: corpusIndexProjectionStates.desiredEpoch,
      fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      indexId: corpusIndexProjectionStates.desiredIndexId,
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
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        inArray(corpusIndexGenerations.status, ["building", "serving"]),
        pendingDesiredState,
        noOutstandingIntent,
      ),
    )
    .orderBy(
      asc(corpusIndexProjectionStates.updatedAt),
      asc(corpusIndexProjectionStates.entityId),
    )
    .limit(limit)
    .for("update", {
      of: corpusIndexProjectionStates,
      skipLocked: true,
    });

  if (candidates.length === 0) {
    return [];
  }
  const leaseExpiresAt =
    testNow === undefined
      ? sql<Date>`clock_timestamp() + ${leaseMs} * INTERVAL '1 millisecond'`
      : new Date(testNow.getTime() + leaseMs);
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
    };
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
    .returning({
      id: corpusIndexProjectionIntents.id,
      leaseExpiresAt: corpusIndexProjectionIntents.leaseExpiresAt,
    });
  if (inserted.length !== reservations.length) {
    return panic(
      `Corpus projection reservation inserted ${inserted.length} of ${reservations.length} intents`,
    );
  }
  const expiryByIntentId = new Map(
    inserted.map(({ id, leaseExpiresAt: insertedExpiry }) => {
      if (insertedExpiry === null) {
        return panic(`Reserved projection intent has no lease expiry: ${id}`);
      }
      return [id, insertedExpiry] as const;
    }),
  );
  return reservations.map((reservation) => {
    const insertedExpiry = expiryByIntentId.get(reservation.intentId);
    if (insertedExpiry === undefined) {
      return panic(
        `Reserved projection intent was not returned: ${reservation.intentId}`,
      );
    }
    return {
      ...reservation,
      leaseExpiresAt: insertedExpiry,
    } satisfies CorpusProjectionIntentLease;
  });
};

export type CorpusProjectionReplacementCleanup = {
  intentId: ProjectionIntentId;
  family: CorpusFamily;
  generation: string;
  entityId: string;
  indexId: string;
};

type PrepareCorpusProjectionReplacementsOptions = {
  family: CorpusFamily;
  generation: string;
  limit: number;
  testNow?: Date;
};

/**
 * Move current but superseded revisions to cleanup before a replacement can
 * be reserved. Applied revisions are known published, so no unknown-append
 * delay is needed; delete settlement remains mandatory.
 */
export const prepareCorpusProjectionReplacementsTx = async (
  tx: Transaction,
  {
    family,
    generation,
    limit: requestedLimit,
    testNow,
  }: PrepareCorpusProjectionReplacementsOptions,
): Promise<CorpusProjectionReplacementCleanup[]> => {
  const limit = validateBatchSize(requestedLimit);
  await readActiveCorpusProjectionManifest(tx, family, generation, true);
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
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        eq(corpusIndexProjectionStates.appliedAction, "upsert"),
        isNotNull(corpusIndexProjectionStates.appliedRevision),
        isNotNull(corpusIndexProjectionStates.appliedIndexId),
        sql`${corpusIndexProjectionStates.desiredEpoch} > ${corpusIndexProjectionStates.appliedEpoch}`,
      ),
    )
    .orderBy(
      asc(corpusIndexProjectionStates.updatedAt),
      asc(corpusIndexProjectionStates.entityId),
    )
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
    .for("update");
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const updated = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      appendPublishBarrierAt: sql`${corpusIndexProjectionIntents.appendCommittedAt}`,
      cleanupNotBefore: transitionAt,
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
  await readActiveCorpusProjectionManifest(
    tx,
    identity.family,
    identity.generation,
    true,
  );
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
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "append_started",
      appendStartedAt: transitionAt,
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "reserved"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
        gt(corpusIndexProjectionIntents.leaseExpiresAt, transitionAt),
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
      lastError: "projection desired state changed before append",
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

type AbandonCorpusProjectionAppendOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  testNow?: Date;
  errorMessage: string;
};

/** Unknown append outcomes are always assumed written and cleaned exactly. */
export const abandonCorpusProjectionAppendTx = async (
  tx: Transaction,
  {
    intentId,
    leaseToken,
    testNow,
    errorMessage,
  }: AbandonCorpusProjectionAppendOptions,
): Promise<"cleanup_pending" | "lease_lost"> => {
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
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
    return "lease_lost";
  }
  const manifest = await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    identity.family,
    identity.generation,
  );
  const rows = await tx
    .select({ appendStartedAt: corpusIndexProjectionIntents.appendStartedAt })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.id, intentId),
        eq(corpusIndexProjectionIntents.status, "append_started"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .limit(1)
    .for("update");
  const intent = rows.at(0);
  if (intent === undefined || intent.appendStartedAt === null) {
    return "lease_lost";
  }
  const barrier = corpusIndexUnknownAppendBarrierAt(
    intent.appendStartedAt,
    manifest,
  );
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
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
  return "cleanup_pending";
};

type CommitCorpusProjectionAppendOptions = {
  intentId: ProjectionIntentId;
  leaseToken: string;
  testNow?: Date;
};

export type CommitCorpusProjectionAppendResult =
  | { status: "applied"; entityId: string }
  | { status: "stale_cleanup_pending"; entityId: string }
  | { status: "lease_lost" };

/**
 * Finalize a successful wait_for append and its authoritative state in one
 * transaction. A desired-state race cannot publish: the exact new revision is
 * redirected to cleanup instead.
 */
export const commitCorpusProjectionAppendTx = async (
  tx: Transaction,
  { intentId, leaseToken, testNow }: CommitCorpusProjectionAppendOptions,
): Promise<CommitCorpusProjectionAppendResult> => {
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
  await readRegisteredCorpusProjectionManifestForCleanup(
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
        appendPublishBarrierAt: transitionAt,
        cleanupNotBefore: transitionAt,
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
