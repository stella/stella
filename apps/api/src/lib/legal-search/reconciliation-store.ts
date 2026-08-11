/**
 * The parked-item store for the standing listing reconciliation.
 *
 * The loop's job is a difference: what a publisher lists for a slice against
 * what is held. An item that cannot be ingested keeps that difference open,
 * and re-listing it every visit would make the hunt loop forever over the same
 * unservable document. A row here closes it, in two stages — a bounded retry
 * schedule, then a terminal disposition that counts the item as accounted for
 * rather than missing, which is what lets a slice reach a fixed point.
 *
 * Every read is bounded and scoped to one source. Nothing here contacts a
 * publisher; the payload is stored verbatim so a retry needs no listing walk.
 */

import { and, count, eq, inArray, lte, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawReconciliationItems,
  RECONCILIATION_ITEM_STATUS,
} from "@/api/db/schema";
import type { ReconciliationItemStatus } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";

const HOUR_IN_MS = 60 * 60 * 1000;

/**
 * Delay before attempt N+1, indexed by the attempt that just failed.
 *
 * Widening on purpose: the first failures are usually a publisher having a
 * bad minute, so an hour is enough; by the fifth the item is more likely to
 * be one the publisher will never serve, and asking weekly costs nothing
 * while leaving room for it to appear.
 */
export const RECONCILIATION_RETRY_DELAYS_MS = [
  HOUR_IN_MS,
  6 * HOUR_IN_MS,
  DAY_IN_MS,
  3 * DAY_IN_MS,
  7 * DAY_IN_MS,
] as const;

/**
 * Attempts after which an item stops being retried. One past the schedule:
 * every delay has been served, and the item still could not be built.
 */
export const RECONCILIATION_TERMINAL_ATTEMPTS =
  RECONCILIATION_RETRY_DELAYS_MS.length + 1;

/**
 * What the next attempt looks like, or that there is none. A union rather
 * than a nullable date: "no next attempt" is a disposition the caller has to
 * record, not a missing value it may ignore.
 */
export type ReconciliationSchedule =
  | { type: "parked"; nextAttemptAt: Date }
  | { type: "terminal" };

type ReconciliationScheduleInput = {
  /** Attempt count including the failure being recorded. */
  attempts: number;
  now: Date;
};

export const reconciliationSchedule = ({
  attempts,
  now,
}: ReconciliationScheduleInput): ReconciliationSchedule => {
  if (attempts >= RECONCILIATION_TERMINAL_ATTEMPTS) {
    return { type: "terminal" };
  }
  const delayMs =
    RECONCILIATION_RETRY_DELAYS_MS[attempts - 1] ??
    RECONCILIATION_RETRY_DELAYS_MS[0];
  return { type: "parked", nextAttemptAt: new Date(now.getTime() + delayMs) };
};

export type ParkedReconciliationItem = {
  id: SafeId<"caseLawReconciliationItem">;
  slice: string;
  identityKey: string;
  payload: unknown;
  attempts: number;
};

export type ParkReconciliationItemInput = {
  sourceId: SafeId<"caseLawSource">;
  slice: string;
  identityKey: string;
  payload: unknown;
  /** An `errorTag`, never a raw message. */
  errorTag: string;
  now: Date;
};

export type ParkReconciliationItemResult = {
  status: ReconciliationItemStatus;
  attempts: number;
};

/**
 * Record one failed attempt against an item, advancing it along the retry
 * schedule and retiring it to `terminal` once the schedule is exhausted.
 *
 * The schedule is applied in TypeScript and written as a literal, rather than
 * recomputed in SQL: a second copy of the backoff in the statement would be
 * free to drift from the one the tests pin. The read-modify-write is safe
 * because the reconciliation loop holds the source's ingestion lease, so this
 * source has exactly one writer.
 */
export const parkReconciliationItem = async (
  scopedDb: ScopedDb,
  {
    sourceId,
    slice,
    identityKey,
    payload,
    errorTag,
    now,
  }: ParkReconciliationItemInput,
): Promise<ParkReconciliationItemResult> => {
  const result = await scopedDb(async (tx) => {
    const existing = (
      await tx
        .select({
          attempts: caseLawReconciliationItems.attempts,
          status: caseLawReconciliationItems.status,
        })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(caseLawReconciliationItems.identityKey, identityKey),
          ),
        )
        .limit(1)
    ).at(0);

    const attempts = (existing?.attempts ?? 0) + 1;
    const schedule = reconciliationSchedule({ attempts, now });
    const status =
      schedule.type === "terminal"
        ? RECONCILIATION_ITEM_STATUS.TERMINAL
        : RECONCILIATION_ITEM_STATUS.PARKED;
    const nextAttemptAt =
      schedule.type === "terminal" ? null : schedule.nextAttemptAt;

    // audit: skip — ingestion bookkeeping for public source data
    await tx
      .insert(caseLawReconciliationItems)
      .values({
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice,
        identityKey,
        payload,
        status,
        attempts,
        nextAttemptAt,
        lastError: errorTag,
        lastAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: [
          caseLawReconciliationItems.sourceId,
          caseLawReconciliationItems.identityKey,
        ],
        set: {
          // A later listing may place the same decision in another slice;
          // the row follows the listing rather than pinning the first one.
          slice,
          payload,
          status,
          attempts,
          nextAttemptAt,
          lastError: errorTag,
          lastAttemptAt: now,
        },
      });

    return {
      status,
      attempts,
      becameTerminal:
        status === RECONCILIATION_ITEM_STATUS.TERMINAL &&
        existing?.status !== RECONCILIATION_ITEM_STATUS.TERMINAL,
    };
  });

  if (result.becameTerminal) {
    // Once, on the transition: an item leaving the hunt is a decision the
    // publisher lists and the corpus will not hold, and it must not happen
    // silently.
    logger.warn("case_law.reconciliation.item_terminal", {
      sourceId,
      slice,
      identityKey,
      attempts: result.attempts,
      "error.type": errorTag,
    });
  }

  return { status: result.status, attempts: result.attempts };
};

export type RetireReconciliationItemInput = {
  sourceId: SafeId<"caseLawSource">;
  slice: string;
  identityKey: string;
  payload: unknown;
  errorTag: string;
  now: Date;
};

/**
 * Retire an item immediately, without serving the retry schedule.
 *
 * For the failure a retry cannot change: the publisher lists something the
 * adapter can never key, so every future attempt reaches the same answer.
 * Parking it would spend five delays proving that.
 */
export const retireReconciliationItem = async (
  scopedDb: ScopedDb,
  {
    sourceId,
    slice,
    identityKey,
    payload,
    errorTag,
    now,
  }: RetireReconciliationItemInput,
): Promise<void> => {
  const becameTerminal = await scopedDb(async (tx) => {
    const existing = (
      await tx
        .select({ status: caseLawReconciliationItems.status })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(caseLawReconciliationItems.identityKey, identityKey),
          ),
        )
        .limit(1)
    ).at(0);

    // audit: skip — ingestion bookkeeping for public source data
    await tx
      .insert(caseLawReconciliationItems)
      .values({
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice,
        identityKey,
        payload,
        status: RECONCILIATION_ITEM_STATUS.TERMINAL,
        attempts: RECONCILIATION_TERMINAL_ATTEMPTS,
        nextAttemptAt: null,
        lastError: errorTag,
        lastAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: [
          caseLawReconciliationItems.sourceId,
          caseLawReconciliationItems.identityKey,
        ],
        set: {
          slice,
          payload,
          status: RECONCILIATION_ITEM_STATUS.TERMINAL,
          attempts: RECONCILIATION_TERMINAL_ATTEMPTS,
          nextAttemptAt: null,
          lastError: errorTag,
          lastAttemptAt: now,
        },
      });

    return existing?.status !== RECONCILIATION_ITEM_STATUS.TERMINAL;
  });

  if (becameTerminal) {
    logger.warn("case_law.reconciliation.item_terminal", {
      sourceId,
      slice,
      identityKey,
      attempts: RECONCILIATION_TERMINAL_ATTEMPTS,
      "error.type": errorTag,
    });
  }
};

export type ResolveReconciliationItemInput = {
  sourceId: SafeId<"caseLawSource">;
  identityKey: string;
};

/**
 * Forget an item because its identity is now held. Deleted rather than marked
 * resolved: the question this table answers is "what is still outstanding",
 * and a held decision answers it from the decisions table itself.
 */
export const resolveReconciliationItem = async (
  scopedDb: ScopedDb,
  { sourceId, identityKey }: ResolveReconciliationItemInput,
): Promise<void> => {
  await scopedDb(async (tx) => {
    // audit: skip — ingestion bookkeeping for public source data
    await tx
      .delete(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          eq(caseLawReconciliationItems.identityKey, identityKey),
        ),
      );
  });
};

export type ResolveReconciliationItemsInput = {
  sourceId: SafeId<"caseLawSource">;
  identityKeys: readonly string[];
};

/**
 * The same, for a batch the caller already knows is held. One bounded delete
 * rather than one per item: a retry batch is checked against the decisions
 * table in a single read, and forgetting its rows should cost a single write.
 */
export const resolveReconciliationItems = async (
  scopedDb: ScopedDb,
  { sourceId, identityKeys }: ResolveReconciliationItemsInput,
): Promise<void> => {
  if (identityKeys.length === 0) {
    return;
  }
  await scopedDb(async (tx) => {
    // audit: skip — ingestion bookkeeping for public source data
    await tx
      .delete(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          inArray(caseLawReconciliationItems.identityKey, [...identityKeys]),
        ),
      );
  });
};

export type SelectDueReconciliationItemsInput = {
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  limit: number;
};

/** Parked items whose next attempt has come due, oldest due first. */
export const selectDueReconciliationItems = async (
  scopedDb: ScopedDb,
  { sourceId, now, limit }: SelectDueReconciliationItemsInput,
): Promise<ParkedReconciliationItem[]> =>
  await scopedDb(
    async (tx) =>
      await tx
        .select({
          id: caseLawReconciliationItems.id,
          slice: caseLawReconciliationItems.slice,
          identityKey: caseLawReconciliationItems.identityKey,
          payload: caseLawReconciliationItems.payload,
          attempts: caseLawReconciliationItems.attempts,
        })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(
              caseLawReconciliationItems.status,
              RECONCILIATION_ITEM_STATUS.PARKED,
            ),
            // eslint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- both sides are millisecond-precision JS Dates this module wrote and reads; a retry due within a microsecond of the cutoff simply comes due on the next turn
            lte(caseLawReconciliationItems.nextAttemptAt, now),
          ),
        )
        .orderBy(caseLawReconciliationItems.nextAttemptAt)
        .limit(limit),
  );

export type ReconciliationItemCounts = {
  parked: number;
  terminal: number;
};

const emptyCounts = (): ReconciliationItemCounts => ({
  parked: 0,
  terminal: 0,
});

/** Per-status totals for one source. Bounded: one row per status. */
export const countReconciliationItems = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
): Promise<ReconciliationItemCounts> => {
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({
          status: caseLawReconciliationItems.status,
          total: count(),
        })
        .from(caseLawReconciliationItems)
        .where(eq(caseLawReconciliationItems.sourceId, sourceId))
        .groupBy(caseLawReconciliationItems.status)
        .limit(Object.keys(RECONCILIATION_ITEM_STATUS).length),
  );
  const counts = emptyCounts();
  for (const { status, total } of rows) {
    switch (status) {
      case RECONCILIATION_ITEM_STATUS.PARKED:
        counts.parked = total;
        break;
      case RECONCILIATION_ITEM_STATUS.TERMINAL:
        counts.terminal = total;
        break;
      default:
        break;
    }
  }
  return counts;
};

export type SelectTrackedIdentityKeysInput = {
  sourceId: SafeId<"caseLawSource">;
  identityKeys: readonly string[];
};

/**
 * Which of these identities the store already tracks, whatever their state.
 *
 * A slice walk must not re-fetch them. A parked item has a schedule and a
 * walk that fetched it anyway would serve none of it — the widening backoff
 * exists precisely so a document the publisher will not serve is asked for
 * less often, and a daily tip walk asking every time defeats it. A terminal
 * item is worse: it has left the hunt, and re-fetching it is the unbounded
 * loop the whole disposition exists to end. Both belong to the due-retry
 * path alone.
 */
export const selectTrackedIdentityKeys = async (
  scopedDb: ScopedDb,
  { sourceId, identityKeys }: SelectTrackedIdentityKeysInput,
): Promise<Set<string>> => {
  if (identityKeys.length === 0) {
    return new Set();
  }
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({ identityKey: caseLawReconciliationItems.identityKey })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            inArray(caseLawReconciliationItems.identityKey, [...identityKeys]),
          ),
        )
        .limit(identityKeys.length),
  );
  return new Set(rows.map(({ identityKey }) => identityKey));
};

export type PruneUnlistedTerminalItemsInput = {
  sourceId: SafeId<"caseLawSource">;
  slice: string;
  /** Every identity the completed walk saw for the slice. */
  listedIdentityKeys: readonly string[];
  /** Rows examined per prune; bounds the read on a pathological slice. */
  limit: number;
};

/**
 * Forget retired items the slice no longer lists.
 *
 * Settledness compares two populations: `reported`/`collected`, which describe
 * the listing as it is now, and the terminal count, which describes rows
 * written whenever they were written. A publisher that drops an identity and
 * lists another in its place leaves the old terminal row behind, and that row
 * then vouches for a shortfall it has nothing to do with — a genuinely missing
 * decision can be marked accounted for by an identity that is no longer even
 * listed. Pruning on a completed walk keeps the terminal term an intersection
 * with the listing it is compared against.
 *
 * Only terminal rows, because only they carry settledness. A parked row keeps
 * its slice short either way, so removing it would buy nothing and would throw
 * away an attempt history.
 */
export const pruneUnlistedTerminalItems = async (
  scopedDb: ScopedDb,
  {
    sourceId,
    slice,
    listedIdentityKeys,
    limit,
  }: PruneUnlistedTerminalItemsInput,
): Promise<number> =>
  await scopedDb(async (tx) => {
    const listed = new Set(listedIdentityKeys);
    const rows = await tx
      .select({ identityKey: caseLawReconciliationItems.identityKey })
      .from(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          eq(caseLawReconciliationItems.slice, slice),
          eq(
            caseLawReconciliationItems.status,
            RECONCILIATION_ITEM_STATUS.TERMINAL,
          ),
        ),
      )
      .limit(limit);
    const unlisted = rows.flatMap(({ identityKey }) =>
      listed.has(identityKey) ? [] : [identityKey],
    );
    if (unlisted.length === 0) {
      return 0;
    }
    // audit: skip — ingestion bookkeeping for public source data
    const removed = await tx
      .delete(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          inArray(caseLawReconciliationItems.identityKey, unlisted),
        ),
      )
      .returning({ id: caseLawReconciliationItems.id });
    return removed.length;
  });

export type CountTerminalBySliceInput = {
  sourceId: SafeId<"caseLawSource">;
  slices: readonly string[];
};

/**
 * How many items each of the named slices has retired. This is the term that
 * makes a short slice settle: held plus terminal accounts for what was
 * listed, so the slice stops being selected.
 */
export const countTerminalReconciliationItemsBySlice = async (
  scopedDb: ScopedDb,
  { sourceId, slices }: CountTerminalBySliceInput,
): Promise<Map<string, number>> => {
  if (slices.length === 0) {
    return new Map();
  }
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({
          slice: caseLawReconciliationItems.slice,
          total: count(),
        })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(
              caseLawReconciliationItems.status,
              RECONCILIATION_ITEM_STATUS.TERMINAL,
            ),
            inArray(caseLawReconciliationItems.slice, [...slices]),
          ),
        )
        .groupBy(caseLawReconciliationItems.slice)
        .limit(slices.length),
  );
  return new Map(rows.map(({ slice, total }) => [slice, total]));
};

export type ResetTerminalReconciliationItemsInput = {
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  limit: number;
};

/**
 * Put retired items back into the hunt, bounded.
 *
 * Terminal means "the schedule proved this cannot be ingested", which is a
 * statement about the publisher and the adapter at the time it was made. A
 * fixed adapter or a publisher that finally serves the document changes that,
 * and nothing else in the loop will ever look at these rows again.
 */
export const resetTerminalReconciliationItems = async (
  scopedDb: ScopedDb,
  { sourceId, now, limit }: ResetTerminalReconciliationItemsInput,
): Promise<number> =>
  await scopedDb(async (tx) => {
    const due = await tx
      .select({ id: caseLawReconciliationItems.id })
      .from(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          eq(
            caseLawReconciliationItems.status,
            RECONCILIATION_ITEM_STATUS.TERMINAL,
          ),
        ),
      )
      .orderBy(caseLawReconciliationItems.firstSeenAt)
      .limit(limit);
    if (due.length === 0) {
      return 0;
    }
    // audit: skip — ingestion bookkeeping for public source data
    const reset = await tx
      .update(caseLawReconciliationItems)
      .set({
        status: RECONCILIATION_ITEM_STATUS.PARKED,
        attempts: 0,
        nextAttemptAt: now,
        lastError: sql`NULL`,
      })
      .where(
        inArray(
          caseLawReconciliationItems.id,
          due.map(({ id }) => id),
        ),
      )
      .returning({ id: caseLawReconciliationItems.id });
    return reset.length;
  });
