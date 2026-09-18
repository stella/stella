import { Result, panic } from "better-result";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { Temporal, DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS,
  caseLawCorpusPackRefs,
  caseLawCorpusUploadIntents,
  caseLawDecisions,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  type ActiveCorpusProjectionSourceLock,
  CorpusIndexProjectionSubjectMissingError,
  lockActiveCorpusProjectionSourceTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { reclaimCorpusUpload } from "@/api/lib/legal-search/corpus-storage";
import type { WriteCorpusResult } from "@/api/lib/legal-search/corpus-storage";

const CLEANUP_RETRY_MAX_DELAY_MS = DAY_IN_MS;
const CLEANUP_RETRY_UNIT_MS = 60 * 1000;
const CORPUS_UPLOAD_INTENT_LEASE_MS = 5 * 60 * 1000;

type CorpusUploadKeys = Pick<
  WriteCorpusResult,
  "astKey" | "sectionsKey" | "textKey"
>;

type CorpusUploadIntentCleanupPlan =
  /** Another reservation claims these addresses; ask again later. */
  | { type: "defer" }
  /**
   * Release what this reservation owns and drop its row. `keys` are the
   * addresses to reclaim (an address a live row points at is excluded), and
   * `releasablePackKeys` are the packs nothing else reaches into, which are
   * therefore the reservation's to delete.
   */
  | {
      type: "release";
      keys: {
        astKey: string | null;
        sectionsKey: string | null;
        textKey: string | null;
      };
      releasablePackKeys: ReadonlySet<string>;
    };

type CorpusUploadIntentLiveness = {
  /** Addresses a decision row still points at. */
  currentKeys: ReadonlySet<string>;
  /** Addresses another reservation still claims. */
  activeKeys: ReadonlySet<string>;
  /**
   * Packs a decision row or another reservation still reaches into. A pack is
   * shared by the batch that wrote it, so its object may only be deleted once
   * nothing reaches into it at all.
   */
  referencedPackKeys: ReadonlySet<string>;
};

type PlannedCorpusUploadIntent = CorpusUploadKeys & {
  packKey: string | null;
};

/**
 * What a cleanup may do with one abandoned reservation.
 *
 * A reservation names addresses it wrote, or meant to write, before its
 * transfer ran. Reclaiming it is not an erasure: the bytes at those addresses
 * were never served to anyone, and the batch that retries re-derives exactly
 * the same addresses, so nothing here may deny them. What it may do is delete
 * objects nothing points at — the standalone keys a live row does not claim,
 * and the pack object itself once no row and no other reservation reaches
 * into it.
 *
 * The row goes either way. A reservation inside a pack that other rows still
 * use has nothing left to reclaim, and keeping it would put it back on the
 * retry path for ever.
 */
export const planCorpusUploadIntentCleanup = (
  intent: PlannedCorpusUploadIntent,
  { currentKeys, activeKeys, referencedPackKeys }: CorpusUploadIntentLiveness,
): CorpusUploadIntentCleanupPlan => {
  const rowKeys = [intent.astKey, intent.sectionsKey, intent.textKey];
  if (rowKeys.some((key) => activeKeys.has(key))) {
    return { type: "defer" };
  }
  const releasablePackKeys =
    intent.packKey === null || referencedPackKeys.has(intent.packKey)
      ? new Set<string>()
      : new Set([intent.packKey]);
  return {
    type: "release",
    keys: {
      astKey: currentKeys.has(intent.astKey) ? null : intent.astKey,
      sectionsKey: currentKeys.has(intent.sectionsKey)
        ? null
        : intent.sectionsKey,
      textKey: currentKeys.has(intent.textKey) ? null : intent.textKey,
    },
    releasablePackKeys,
  };
};

/** One decision's share of a batch's pack, as the reservation records it. */
export type CaseLawCorpusUploadReservationInput = {
  contentHash: string;
  decisionId: SafeId<"caseLawDecision">;
  /**
   * Where this decision's three payloads will be: packed addresses when the
   * batch wrote members for it, the derived object keys when it contributed
   * none. Either way the reservation names exactly what the settlement will
   * store, so cleanup owns it.
   */
  written: WriteCorpusResult;
  /** The pack those addresses belong to, or null for object keys. */
  packKey: string | null;
};

export type ReserveCaseLawCorpusUploadIntentResult =
  | {
      intentId: SafeId<"caseLawCorpusUploadIntent">;
      type: "reserved";
      written: WriteCorpusResult;
    }
  | { type: "busy" }
  | { type: "redacted" };

type ReserveCaseLawCorpusUploadIntentsOptions = {
  reservations: readonly CaseLawCorpusUploadReservationInput[];
  scopedDb: ScopedDb;
};

const leaseExpiry = (): Date =>
  new Date(
    Temporal.Now.instant().epochMilliseconds + CORPUS_UPLOAD_INTENT_LEASE_MS,
  );

const intentValues = (
  reservation: CaseLawCorpusUploadReservationInput,
  intentId: SafeId<"caseLawCorpusUploadIntent">,
  leaseExpiresAt: Date,
) => ({
  id: intentId,
  decisionId: reservation.decisionId,
  textS3Key: reservation.written.textKey,
  normalizedS3Key: reservation.written.sectionsKey,
  astS3Key: reservation.written.astKey,
  packKey: reservation.packKey,
  leaseExpiresAt,
});

export type CaseLawCorpusUploadReservations = Map<
  SafeId<"caseLawDecision">,
  ReserveCaseLawCorpusUploadIntentResult
>;

/**
 * Reserve the exact addresses of a whole batch before its transfer.
 *
 * One transaction for the batch, not one per decision: the reservations are
 * what makes an upload discoverable if it lands and its row does not, and a
 * batch that reserved half its decisions before failing would leave the rest
 * of its pack owned by nobody. `FOR SHARE` on the decisions serializes the
 * reservation with redaction's `FOR UPDATE` fence, so either the upload is
 * durable for cancellation or the tombstone prevents it starting. The rows
 * are taken in id order, so two batches that overlap queue behind each other
 * instead of deadlocking.
 *
 * The failure is returned: a batch that could not reserve has an answer about
 * the page it was given, and its caller decides whether that holds a cursor.
 */
export const reserveCaseLawCorpusUploadIntents = async ({
  reservations,
  scopedDb,
}: ReserveCaseLawCorpusUploadIntentsOptions): Promise<
  Result<CaseLawCorpusUploadReservations, unknown>
> => {
  const outcomes: CaseLawCorpusUploadReservations = new Map();
  if (reservations.length === 0) {
    return Result.ok(outcomes);
  }
  const byDecision = new Map(
    reservations.map((reservation) => [reservation.decisionId, reservation]),
  );
  // Decision ids, not words: this fixes the order the rows are locked in.
  const decisionIds = [...byDecision.keys()].sort((left, right) =>
    left < right ? -1 : 1,
  );

  return await Result.tryPromise({
    try: async () =>
      await scopedDb(async (tx) => {
        const decisions = await tx
          .select({
            id: caseLawDecisions.id,
            redactedAt: caseLawDecisions.redactedAt,
          })
          .from(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, decisionIds))
          .for("share");
        const live = new Set(
          decisions
            .filter(({ redactedAt }) => redactedAt === null)
            .map(({ id }) => id),
        );
        for (const decisionId of decisionIds) {
          if (!live.has(decisionId)) {
            outcomes.set(decisionId, { type: "redacted" });
          }
        }

        const leaseExpiresAt = leaseExpiry();
        const pending = decisionIds.filter((decisionId) =>
          live.has(decisionId),
        );
        if (pending.length === 0) {
          return outcomes;
        }
        const freshIds = new Map(
          pending.map((decisionId) => [
            decisionId,
            createSafeId<"caseLawCorpusUploadIntent">(),
          ]),
        );
        const inserted = await tx
          .insert(caseLawCorpusUploadIntents)
          .values(
            pending.map((decisionId) =>
              intentValues(
                byDecision.get(decisionId) ?? panic("Reservation lost"),
                freshIds.get(decisionId) ?? panic("Reserved intent id lost"),
                leaseExpiresAt,
              ),
            ),
          )
          .onConflictDoNothing()
          .returning({
            id: caseLawCorpusUploadIntents.id,
            decisionId: caseLawCorpusUploadIntents.decisionId,
          });
        for (const { id, decisionId } of inserted) {
          outcomes.set(decisionId, {
            intentId: id,
            type: "reserved",
            written: (byDecision.get(decisionId) ?? panic("Reservation lost"))
              .written,
          });
        }

        // Whatever the insert did not take already carries an active
        // reservation: either a live one (another writer owns the decision) or an
        // expired lease this batch may take over.
        const contended = pending.filter(
          (decisionId) => !outcomes.has(decisionId),
        );
        if (contended.length === 0) {
          return outcomes;
        }
        const active = await tx
          .select({
            id: caseLawCorpusUploadIntents.id,
            decisionId: caseLawCorpusUploadIntents.decisionId,
            textKey: caseLawCorpusUploadIntents.textS3Key,
            sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
            astKey: caseLawCorpusUploadIntents.astS3Key,
            leaseExpiresAt: caseLawCorpusUploadIntents.leaseExpiresAt,
          })
          .from(caseLawCorpusUploadIntents)
          .where(
            and(
              inArray(caseLawCorpusUploadIntents.decisionId, contended),
              eq(
                caseLawCorpusUploadIntents.status,
                CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
              ),
            ),
          )
          .for("update");

        const now = Temporal.Now.instant().epochMilliseconds;
        const renewed: SafeId<"caseLawCorpusUploadIntent">[] = [];
        const superseded: SafeId<"caseLawCorpusUploadIntent">[] = [];
        const replacements: SafeId<"caseLawDecision">[] = [];
        for (const row of active) {
          const reservation =
            byDecision.get(row.decisionId) ?? panic("Reservation lost");
          if (row.leaseExpiresAt.getTime() > now) {
            outcomes.set(row.decisionId, { type: "busy" });
            continue;
          }
          const samePayload =
            row.textKey === reservation.written.textKey &&
            row.sectionsKey === reservation.written.sectionsKey &&
            row.astKey === reservation.written.astKey;
          if (samePayload) {
            renewed.push(row.id);
            outcomes.set(row.decisionId, {
              intentId: row.id,
              type: "reserved",
              written: reservation.written,
            });
            continue;
          }
          superseded.push(row.id);
          replacements.push(row.decisionId);
        }
        for (const decisionId of contended) {
          if (!outcomes.has(decisionId)) {
            // The row carries no active reservation any more: another writer
            // settled between the insert and the lock.
            outcomes.set(decisionId, { type: "busy" });
          }
        }

        if (renewed.length > 0) {
          await tx
            .update(caseLawCorpusUploadIntents)
            .set({ leaseExpiresAt })
            .where(inArray(caseLawCorpusUploadIntents.id, renewed));
        }
        if (superseded.length > 0) {
          // The expired reservation named other addresses; it keeps its row as a
          // cleanup target and stops being the decision's active one, which is
          // what lets the replacement below take the partial unique index.
          await tx
            .update(caseLawCorpusUploadIntents)
            .set({
              status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
              nextCleanupAt: new Date(),
            })
            .where(inArray(caseLawCorpusUploadIntents.id, superseded));
          await tx
            .insert(caseLawCorpusUploadIntents)
            .values(
              replacements.map((decisionId) =>
                intentValues(
                  byDecision.get(decisionId) ?? panic("Reservation lost"),
                  freshIds.get(decisionId) ?? panic("Reserved intent id lost"),
                  leaseExpiresAt,
                ),
              ),
            );
          for (const decisionId of replacements) {
            outcomes.set(decisionId, {
              intentId:
                freshIds.get(decisionId) ?? panic("Reserved intent id lost"),
              type: "reserved",
              written: (byDecision.get(decisionId) ?? panic("Reservation lost"))
                .written,
            });
          }
        }
        return outcomes;
      }),
    catch: (cause) => cause,
  });
};

/**
 * Record which pack each of a decision's pointers now addresses, in the
 * transaction that writes those pointers.
 *
 * Delete-then-insert rather than an upsert: a repoint may move a decision
 * from a pack to standalone objects, and the reference that stops being true
 * has to go with it or it would pin a pack nothing reaches any more.
 */
const recordCorpusPackRefsTx = async (
  tx: Transaction,
  decisionId: SafeId<"caseLawDecision">,
  written: WriteCorpusResult | null,
): Promise<void> => {
  await tx
    .delete(caseLawCorpusPackRefs)
    .where(eq(caseLawCorpusPackRefs.decisionId, decisionId));
  if (written === null) {
    return;
  }
  const refs = (
    [
      ["text", written.textKey],
      ["sections", written.sectionsKey],
      ["ast", written.astKey],
    ] as const
  ).flatMap(([kind, storedKey]) => {
    const location = parseCorpusLocation(storedKey);
    return location.type === "packed"
      ? [
          {
            decisionId,
            kind,
            packKey: location.packKey,
            location: storedKey,
          },
        ]
      : [];
  });
  if (refs.length === 0) {
    return;
  }
  await tx.insert(caseLawCorpusPackRefs).values(refs);
};

export type CaseLawCorpusUploadApplyResult =
  | { type: "applied" }
  | { type: "superseded" };

type SettleReservedCaseLawCorpusUploadOptions = {
  /**
   * Row CAS for the settled state. `written` is null when the batch
   * concluded the payload carries no document, in which case the CAS
   * settles the mirror with null pointers instead of addresses.
   */
  apply: (args: {
    projectionLock: ActiveCorpusProjectionSourceLock | null;
    tx: Transaction;
    written: WriteCorpusResult | null;
  }) => Promise<CaseLawCorpusUploadApplyResult>;
  decisionId: SafeId<"caseLawDecision">;
  intentId: SafeId<"caseLawCorpusUploadIntent">;
  preflight: (tx: Transaction) => Promise<boolean>;
  scopedDb: ScopedDb;
  signal?: AbortSignal;
  /** The durable addresses this settlement records, or null for none. */
  written: WriteCorpusResult | null;
};

export type SettleReservedCaseLawCorpusUploadResult =
  | CaseLawCorpusUploadApplyResult
  | { type: "redacted-or-missing" }
  | { type: "intent-reclaimed" };

/**
 * Point a decision's row at payloads that are already durable.
 *
 * The transaction fences the row the way redaction does, so a redaction
 * cannot win between the final tombstone check and this repoint. What it no
 * longer holds is the transfer: the batch wrote its pack before reaching
 * here, under a reservation that owns the addresses if this settlement never
 * happens. The active intent disappears in the same commit as the pointers.
 */
export const settleReservedCaseLawCorpusUpload = async ({
  apply,
  decisionId,
  intentId,
  preflight,
  scopedDb,
  signal,
  written,
}: SettleReservedCaseLawCorpusUploadOptions): Promise<SettleReservedCaseLawCorpusUploadResult> =>
  await scopedDb(async (tx) => {
    signal?.throwIfAborted();
    const sourceLock = await Result.tryPromise({
      try: async () =>
        await lockActiveCorpusProjectionSourceTx(tx, {
          family: "case_law",
          entityId: decisionId,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(sourceLock)) {
      if (
        sourceLock.error instanceof CorpusIndexProjectionSubjectMissingError
      ) {
        return { type: "redacted-or-missing" };
      }
      throw sourceLock.error;
    }
    const decision = (
      await tx
        .select({ redactedAt: caseLawDecisions.redactedAt })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (!decision || decision.redactedAt !== null) {
      await tx
        .update(caseLawCorpusUploadIntents)
        .set({
          status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          nextCleanupAt: new Date(),
        })
        .where(
          and(
            eq(caseLawCorpusUploadIntents.id, intentId),
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
            ),
          ),
        );
      return { type: "redacted-or-missing" };
    }

    const intent = (
      await tx
        .select({ status: caseLawCorpusUploadIntents.status })
        .from(caseLawCorpusUploadIntents)
        .where(
          and(
            eq(caseLawCorpusUploadIntents.id, intentId),
            eq(caseLawCorpusUploadIntents.decisionId, decisionId),
          ),
        )
        .for("update")
        .limit(1)
    ).at(0);
    if (intent?.status !== CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE) {
      return { type: "intent-reclaimed" };
    }

    if (!(await preflight(tx))) {
      await tx
        .update(caseLawCorpusUploadIntents)
        .set({
          status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          nextCleanupAt: new Date(),
        })
        .where(eq(caseLawCorpusUploadIntents.id, intentId));
      return { type: "superseded" };
    }

    const outcome = await apply({
      projectionLock: sourceLock.value,
      tx,
      written,
    });
    if (outcome.type === "superseded") {
      await tx
        .update(caseLawCorpusUploadIntents)
        .set({
          status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          nextCleanupAt: new Date(),
        })
        .where(eq(caseLawCorpusUploadIntents.id, intentId));
      return outcome;
    }

    await recordCorpusPackRefsTx(tx, decisionId, written);

    const removed = (
      await tx
        .delete(caseLawCorpusUploadIntents)
        .where(
          and(
            eq(caseLawCorpusUploadIntents.id, intentId),
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
            ),
          ),
        )
        .returning({ id: caseLawCorpusUploadIntents.id })
    ).at(0);
    if (!removed) {
      return panic("Corpus upload intent disappeared before settlement");
    }
    return outcome;
  });

export type CancelledCaseLawCorpusUploadIntent = CorpusUploadKeys & {
  id: SafeId<"caseLawCorpusUploadIntent">;
};

/**
 * Must run in redaction's decision-row `FOR UPDATE` transaction. It retains
 * the exact keys until an immediate delete or the durable sweeper confirms
 * deletion, so a late or abandoned PUT remains owned by erasure.
 */
export const cancelCaseLawCorpusUploadIntents = async ({
  decisionId,
  tx,
}: {
  decisionId: SafeId<"caseLawDecision">;
  tx: Transaction;
}): Promise<CancelledCaseLawCorpusUploadIntent[]> =>
  await tx
    .update(caseLawCorpusUploadIntents)
    .set({
      status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
      nextCleanupAt: new Date(),
    })
    .where(
      and(
        eq(caseLawCorpusUploadIntents.decisionId, decisionId),
        eq(
          caseLawCorpusUploadIntents.status,
          CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
        ),
      ),
    )
    .returning({
      id: caseLawCorpusUploadIntents.id,
      textKey: caseLawCorpusUploadIntents.textS3Key,
      sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
      astKey: caseLawCorpusUploadIntents.astS3Key,
    });

/**
 * Mark the reservations of a failed batch for durable cleanup. One statement
 * for the batch: a pack that landed without its rows leaves every one of its
 * contributing decisions in the same state.
 */
export const enqueueCaseLawCorpusUploadIntentCleanups = async ({
  intentIds,
  scopedDb,
}: {
  intentIds: readonly SafeId<"caseLawCorpusUploadIntent">[];
  scopedDb: ScopedDb;
}): Promise<void> => {
  if (intentIds.length === 0) {
    return;
  }
  await scopedDb(async (tx) => {
    await tx
      .update(caseLawCorpusUploadIntents)
      .set({
        status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
        nextCleanupAt: new Date(),
      })
      .where(
        and(
          inArray(caseLawCorpusUploadIntents.id, [...intentIds]),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
          ),
        ),
      );
  });
};

/**
 * Remove cancelled intents only after their exact-key deletes succeeded. The
 * caller passes the intents whose objects are gone, so an intent whose delete
 * failed keeps its row and stays a retry target.
 */
export const completeCaseLawCorpusUploadIntentCleanups = async ({
  intentIds,
  scopedDb,
}: {
  intentIds: readonly SafeId<"caseLawCorpusUploadIntent">[];
  scopedDb: ScopedDb;
}): Promise<void> => {
  if (intentIds.length === 0) {
    return;
  }
  await scopedDb(async (tx) => {
    await tx
      .delete(caseLawCorpusUploadIntents)
      .where(
        and(
          inArray(caseLawCorpusUploadIntents.id, [...intentIds]),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          ),
        ),
      );
  });
};

export const corpusUploadCleanupDelayMs = (attemptCount: number): number =>
  Math.min(
    CLEANUP_RETRY_UNIT_MS * 2 ** Math.min(attemptCount, 11),
    CLEANUP_RETRY_MAX_DELAY_MS,
  );

type ReconcileCaseLawCorpusUploadIntentsOptions = {
  /** Test seam; production reclaims through the corpus bucket client. */
  reclaim?: typeof reclaimCorpusUpload;
  limit: number;
  safeDb: SafeDb;
  signal?: AbortSignal;
};

export type ReconcileCaseLawCorpusUploadIntentsResult = {
  claimed: number;
  cleaned: number;
};

/**
 * Bounded durable cleanup worker. Expired active leases become cleanup work;
 * locking candidates with SKIP LOCKED makes scheduler replicas converge
 * without duplicate ownership.
 */
export const reconcileCaseLawCorpusUploadIntents = async ({
  reclaim = reclaimCorpusUpload,
  limit,
  safeDb,
  signal,
}: ReconcileCaseLawCorpusUploadIntentsOptions): Promise<ReconcileCaseLawCorpusUploadIntentsResult> => {
  if (!Number.isInteger(limit) || limit < 1) {
    return panic("Corpus upload cleanup limit must be a positive integer");
  }
  signal?.throwIfAborted();
  const now = new Date();
  const claimedResult = await safeDb(async (tx) => {
    const rows = await tx
      .select({
        id: caseLawCorpusUploadIntents.id,
        decisionId: caseLawCorpusUploadIntents.decisionId,
        textKey: caseLawCorpusUploadIntents.textS3Key,
        sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
        astKey: caseLawCorpusUploadIntents.astS3Key,
        packKey: caseLawCorpusUploadIntents.packKey,
        cleanupAttemptCount: caseLawCorpusUploadIntents.cleanupAttemptCount,
      })
      .from(caseLawCorpusUploadIntents)
      .where(
        or(
          and(
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
            ),
            lte(caseLawCorpusUploadIntents.nextCleanupAt, now),
          ),
          and(
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
            ),
            lte(caseLawCorpusUploadIntents.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(
        asc(
          sql`COALESCE(${caseLawCorpusUploadIntents.nextCleanupAt}, ${caseLawCorpusUploadIntents.leaseExpiresAt})`,
        ),
        asc(caseLawCorpusUploadIntents.id),
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    if (rows.length > 0) {
      await tx
        .update(caseLawCorpusUploadIntents)
        .set({
          status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          cleanupAttemptCount: sql`${caseLawCorpusUploadIntents.cleanupAttemptCount} + 1`,
          nextCleanupAt: sql`now() + (
            LEAST(
              ${CLEANUP_RETRY_MAX_DELAY_MS},
              ${CLEANUP_RETRY_UNIT_MS} * POWER(
                2,
                LEAST(${caseLawCorpusUploadIntents.cleanupAttemptCount}, 11)
              )
            ) * interval '1 millisecond'
          )`,
        })
        .where(
          inArray(
            caseLawCorpusUploadIntents.id,
            rows.map(({ id }) => id),
          ),
        );
    }
    return rows;
  });
  if (Result.isError(claimedResult)) {
    throw claimedResult.error;
  }

  if (claimedResult.value.length === 0) {
    return { claimed: 0, cleaned: 0 };
  }

  const cleanupResult = await safeDb(async (tx) => {
    signal?.throwIfAborted();
    const decisionIds = claimedResult.value.map(({ decisionId }) => decisionId);
    const claimedPackKeys = [
      ...new Set(
        claimedResult.value
          .map(({ packKey }) => packKey)
          .filter((packKey): packKey is string => packKey !== null),
      ),
    ];
    const decisions = await tx
      .select({
        id: caseLawDecisions.id,
        textKey: caseLawDecisions.textS3Key,
        sectionsKey: caseLawDecisions.normalizedS3Key,
        astKey: caseLawDecisions.astS3Key,
      })
      .from(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, decisionIds))
      .for("update");
    const activeIntents = await tx
      .select({
        textKey: caseLawCorpusUploadIntents.textS3Key,
        sectionsKey: caseLawCorpusUploadIntents.normalizedS3Key,
        astKey: caseLawCorpusUploadIntents.astS3Key,
      })
      .from(caseLawCorpusUploadIntents)
      .where(
        and(
          inArray(caseLawCorpusUploadIntents.decisionId, decisionIds),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
          ),
        ),
      );
    // Is anything still reaching into these packs? Two indexed equality
    // lookups: the pointer columns hold addresses, so asking the decisions
    // table the same question would mean a pattern scan of it.
    const packRefs =
      claimedPackKeys.length === 0
        ? []
        : await tx
            .select({ packKey: caseLawCorpusPackRefs.packKey })
            .from(caseLawCorpusPackRefs)
            .where(inArray(caseLawCorpusPackRefs.packKey, claimedPackKeys));
    const packReservations =
      claimedPackKeys.length === 0
        ? []
        : await tx
            .select({ packKey: caseLawCorpusUploadIntents.packKey })
            .from(caseLawCorpusUploadIntents)
            .where(
              and(
                inArray(caseLawCorpusUploadIntents.packKey, claimedPackKeys),
                eq(
                  caseLawCorpusUploadIntents.status,
                  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
                ),
              ),
            );
    const referencedPackKeys = new Set([
      ...packRefs.map(({ packKey }) => packKey),
      ...packReservations.flatMap(({ packKey }) =>
        packKey === null ? [] : [packKey],
      ),
    ]);

    const currentKeys = new Set(
      decisions.flatMap(({ astKey, sectionsKey, textKey }) =>
        [astKey, sectionsKey, textKey].filter(
          (key): key is string => key !== null,
        ),
      ),
    );
    const activeKeys = new Set(
      activeIntents.flatMap(({ astKey, sectionsKey, textKey }) => [
        astKey,
        sectionsKey,
        textKey,
      ]),
    );
    const corpusIoOptions = signal === undefined ? {} : { signal };
    const cleanupResults = await Promise.all(
      claimedResult.value.map(async (row) => {
        const plan = planCorpusUploadIntentCleanup(
          {
            astKey: row.astKey,
            sectionsKey: row.sectionsKey,
            textKey: row.textKey,
            packKey: row.packKey,
          },
          { currentKeys, activeKeys, referencedPackKeys },
        );
        if (plan.type === "defer") {
          return null;
        }
        const released = await Result.tryPromise({
          try: async () =>
            await reclaim({
              ...corpusIoOptions,
              keys: plan.keys,
              releasablePackKeys: plan.releasablePackKeys,
            }),
          catch: (cause) => cause,
        });
        if (Result.isError(released)) {
          captureError(released.error, {
            corpusUploadIntentId: row.id,
            step: "reconcileCaseLawCorpusUploadIntents.reclaim",
          });
          return null;
        }
        switch (released.value.type) {
          case "released":
          case "retained":
            // Either way the reservation has nothing left to own: what it
            // named is gone, or it sits inside a pack other rows keep alive
            // and no later attempt could reclaim it. The outcome is read
            // rather than discarded, because a row kept here is retried for
            // ever.
            return row.id;
          default:
            released.value satisfies never;
            return panic(`Unhandled reclaim: ${String(released.value)}`);
        }
      }),
    );
    const cleanedIds = cleanupResults.filter(
      (id): id is SafeId<"caseLawCorpusUploadIntent"> => id !== null,
    );
    if (cleanedIds.length === 0) {
      return 0;
    }
    const removed = await tx
      .delete(caseLawCorpusUploadIntents)
      .where(
        and(
          inArray(caseLawCorpusUploadIntents.id, cleanedIds),
          eq(
            caseLawCorpusUploadIntents.status,
            CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          ),
        ),
      )
      .returning({ id: caseLawCorpusUploadIntents.id });
    return removed.length;
  });
  if (Result.isError(cleanupResult)) {
    throw cleanupResult.error;
  }
  const cleaned = cleanupResult.value;

  return { claimed: claimedResult.value.length, cleaned };
};
