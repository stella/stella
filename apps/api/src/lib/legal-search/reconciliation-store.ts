import { panic } from "better-result";
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
import { and, count, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawReconciliationItems,
  caseLawSources,
  RECONCILIATION_ITEM_STATUS,
  RECONCILIATION_MAX_REVIVALS,
} from "@/api/db/schema";
import type { ReconciliationItemStatus } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { chunked } from "@/api/lib/chunked";
import { executedRows } from "@/api/lib/db/executed-rows";
import { logger } from "@/api/lib/observability/logger";

import { fingerprintReconciliationPayload } from "./reconciliation-payload";

type ReconciliationLease = {
  sourceId: SafeId<"caseLawSource">;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
};

/** Source first, then item: the row lock fences takeover until this bookkeeping commits. */
const hasReconciliationLease = async (
  tx: Transaction,
  { sourceId, leaseToken }: ReconciliationLease,
) => {
  const owned = (
    await tx
      .select({ id: caseLawSources.id })
      .from(caseLawSources)
      .where(
        and(
          eq(caseLawSources.id, sourceId),
          eq(caseLawSources.ingestionLeaseToken, leaseToken),
          sql`${caseLawSources.ingestionLeaseExpiresAt} > now()`,
        ),
      )
      .for("update")
      .limit(1)
  ).at(0);
  return owned !== undefined;
};

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
type ReconciliationSchedule =
  | { type: "parked"; nextAttemptAt: Date }
  | { type: "terminal" };

type ReconciliationScheduleInput = {
  /** Attempt count including the failure being recorded. */
  attempts: number;
  now: Date;
};

const reconciliationSchedule = ({
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
  payloadHash: string | null;
  attempts: number;
};

type ReconciliationRevision = {
  revisionOf: (payload: unknown) => unknown;
};

export type ParkReconciliationItemInput = ReconciliationLease &
  ReconciliationRevision & {
    slice: string;
    identityKey: string;
    payload: unknown;
    /** An `errorTag`, never a raw message. */
    errorTag: string;
    now: Date;
  };

export type ParkReconciliationItemResult =
  | { outcome: "superseded" }
  | { outcome: "recorded"; status: ReconciliationItemStatus; attempts: number };

export type ReconciliationMutationOutcome = {
  outcome: "recorded" | "superseded";
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
    leaseToken,
    slice,
    identityKey,
    payload,
    revisionOf,
    errorTag,
    now,
  }: ParkReconciliationItemInput,
): Promise<ParkReconciliationItemResult> => {
  const payloadHash = fingerprintReconciliationPayload(revisionOf(payload));
  const result = await scopedDb(async (tx) => {
    if (!(await hasReconciliationLease(tx, { sourceId, leaseToken }))) {
      return { outcome: "superseded" as const };
    }
    const existing = (
      await tx
        .select({
          attempts: caseLawReconciliationItems.attempts,
          status: caseLawReconciliationItems.status,
          payload: sql<unknown>`CASE WHEN ${caseLawReconciliationItems.payloadHash} IS NULL THEN ${caseLawReconciliationItems.payload} ELSE NULL END`,
          payloadHash: caseLawReconciliationItems.payloadHash,
        })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(caseLawReconciliationItems.identityKey, identityKey),
          ),
        )
        .for("update")
        .limit(1)
    ).at(0);

    if (
      existing !== undefined &&
      (existing.payloadHash ??
        fingerprintReconciliationPayload(revisionOf(existing.payload))) !==
        payloadHash
    ) {
      return { outcome: "superseded" as const };
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    const schedule = reconciliationSchedule({ attempts, now });
    const status =
      schedule.type === "terminal"
        ? RECONCILIATION_ITEM_STATUS.TERMINAL
        : RECONCILIATION_ITEM_STATUS.PARKED;
    const nextAttemptAt =
      schedule.type === "terminal" ? null : schedule.nextAttemptAt;

    // audit: skip — ingestion bookkeeping for public source data
    const written = await tx
      .insert(caseLawReconciliationItems)
      .values({
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice,
        identityKey,
        payload,
        payloadHash,
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
        setWhere: sql`${caseLawReconciliationItems.payloadHash} IS NOT DISTINCT FROM ${existing?.payloadHash ?? null}`,
        set: {
          // A later listing may place the same decision in another slice;
          // the row follows the listing rather than pinning the first one.
          slice,
          payload,
          payloadHash,
          status,
          attempts,
          nextAttemptAt,
          lastError: errorTag,
          lastAttemptAt: now,
        },
      })
      .returning({ id: caseLawReconciliationItems.id });
    if (written.length === 0) {
      return { outcome: "superseded" as const };
    }

    return {
      outcome: "recorded" as const,
      status,
      attempts,
      becameTerminal:
        status === RECONCILIATION_ITEM_STATUS.TERMINAL &&
        existing?.status !== RECONCILIATION_ITEM_STATUS.TERMINAL,
    };
  });

  if (result.outcome === "superseded") {
    return result;
  }
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

  return {
    outcome: "recorded",
    status: result.status,
    attempts: result.attempts,
  };
};

export type RetireReconciliationItemInput = ReconciliationLease &
  ReconciliationRevision & {
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
    leaseToken,
    slice,
    identityKey,
    payload,
    revisionOf,
    errorTag,
    now,
  }: RetireReconciliationItemInput,
): Promise<ReconciliationMutationOutcome> => {
  const payloadHash = fingerprintReconciliationPayload(revisionOf(payload));
  const result = await scopedDb(async (tx) => {
    if (!(await hasReconciliationLease(tx, { sourceId, leaseToken }))) {
      return { outcome: "superseded" as const };
    }
    const existing = (
      await tx
        .select({
          status: caseLawReconciliationItems.status,
          payload: sql<unknown>`CASE WHEN ${caseLawReconciliationItems.payloadHash} IS NULL THEN ${caseLawReconciliationItems.payload} ELSE NULL END`,
          payloadHash: caseLawReconciliationItems.payloadHash,
        })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(caseLawReconciliationItems.identityKey, identityKey),
          ),
        )
        .for("update")
        .limit(1)
    ).at(0);

    if (
      existing !== undefined &&
      (existing.payloadHash ??
        fingerprintReconciliationPayload(revisionOf(existing.payload))) !==
        payloadHash
    ) {
      return { outcome: "superseded" as const };
    }

    // audit: skip — ingestion bookkeeping for public source data
    const written = await tx
      .insert(caseLawReconciliationItems)
      .values({
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice,
        identityKey,
        payload,
        payloadHash,
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
        setWhere: sql`${caseLawReconciliationItems.payloadHash} IS NOT DISTINCT FROM ${existing?.payloadHash ?? null}`,
        set: {
          slice,
          payload,
          payloadHash,
          status: RECONCILIATION_ITEM_STATUS.TERMINAL,
          attempts: RECONCILIATION_TERMINAL_ATTEMPTS,
          nextAttemptAt: null,
          lastError: errorTag,
          lastAttemptAt: now,
        },
      })
      .returning({ id: caseLawReconciliationItems.id });
    if (written.length === 0) {
      return { outcome: "superseded" as const };
    }

    return {
      outcome: "recorded" as const,
      becameTerminal: existing?.status !== RECONCILIATION_ITEM_STATUS.TERMINAL,
    };
  });

  if (result.outcome === "superseded") {
    return result;
  }
  if (result.becameTerminal) {
    logger.warn("case_law.reconciliation.item_terminal", {
      sourceId,
      slice,
      identityKey,
      attempts: RECONCILIATION_TERMINAL_ATTEMPTS,
      "error.type": errorTag,
    });
  }
  return { outcome: "recorded" };
};

export type ResolveReconciliationItemInput = ReconciliationLease & {
  identityKey: string;
  payload: unknown;
};

/** Only the listing revision actually consumed may leave the retry ledger. */
export const resolveReconciliationItem = async (
  scopedDb: ScopedDb,
  {
    sourceId,
    leaseToken,
    identityKey,
    payload,
  }: ResolveReconciliationItemInput,
): Promise<ReconciliationMutationOutcome> =>
  await scopedDb(async (tx) => {
    if (!(await hasReconciliationLease(tx, { sourceId, leaseToken }))) {
      return { outcome: "superseded" as const };
    }
    // audit: skip — ingestion bookkeeping for public source data
    const removed = await tx
      .delete(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          eq(caseLawReconciliationItems.identityKey, identityKey),
          sql`${caseLawReconciliationItems.payload} = ${JSON.stringify(payload)}::text::jsonb`,
        ),
      )
      .returning({ id: caseLawReconciliationItems.id });
    return { outcome: removed.length === 0 ? "superseded" : "recorded" };
  });

type ResolveReconciliationItemsInput = ReconciliationLease & {
  items: readonly Pick<
    ParkedReconciliationItem,
    "identityKey" | "payloadHash"
  >[];
};

/** Resolve a bounded batch of held listings without a transaction per identity. */
export const resolveReconciliationItems = async (
  scopedDb: ScopedDb,
  { sourceId, leaseToken, items }: ResolveReconciliationItemsInput,
): Promise<ReconciliationMutationOutcome> => {
  for (const page of chunked(items, LISTING_REVISION_BATCH_SIZE)) {
    const result = await scopedDb(async (tx) => {
      if (!(await hasReconciliationLease(tx, { sourceId, leaseToken }))) {
        return { outcome: "superseded" as const };
      }
      const identities = page.map(({ identityKey, payloadHash }) => ({
        identityKey,
        payloadHash,
      }));
      // audit: skip — ingestion bookkeeping for public source data
      const removed = executedRows(
        await tx.execute(sql`
        DELETE FROM ${caseLawReconciliationItems} AS tracked
        USING jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb)
          AS incoming("identityKey" text, "payloadHash" text)
        WHERE tracked.source_id = ${sourceId}
          AND tracked.identity_key = incoming."identityKey"
          AND tracked.payload_hash IS NOT DISTINCT FROM incoming."payloadHash"
        RETURNING tracked.id
      `),
      );
      if (removed.length !== page.length) {
        logger.warn("case_law.reconciliation.batch_resolution_mismatch", {
          sourceId,
          expected: page.length,
          removed: removed.length,
        });
        return { outcome: "superseded" as const };
      }
      return { outcome: "recorded" as const };
    });
    if (result.outcome === "superseded") {
      return result;
    }
  }
  return { outcome: "recorded" };
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
          payloadHash: caseLawReconciliationItems.payloadHash,
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
            // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- both sides are millisecond-precision JS Dates this module wrote and reads; a retry due within a microsecond of the cutoff simply comes due on the next turn
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

const LISTING_REVISION_BATCH_SIZE = 250;
type RefreshTrackedReconciliationItemsOptions = ReconciliationLease &
  ReconciliationRevision & {
    items: readonly { identityKey: string; slice: string; payload: unknown }[];
    now: Date;
  };

type RefreshTrackedReconciliationItemsResult =
  | { outcome: "superseded" }
  | {
      outcome: "refreshed";
      trackedIdentityKeys: Set<string>;
      refreshedIdentityKeys: Set<string>;
    };

/** Reopen corrected input before item budgets; unchanged revisions keep their schedule. */
export const refreshTrackedReconciliationItems = async (
  scopedDb: ScopedDb,
  {
    sourceId,
    leaseToken,
    items,
    revisionOf,
    now,
  }: RefreshTrackedReconciliationItemsOptions,
): Promise<RefreshTrackedReconciliationItemsResult> => {
  const trackedIdentityKeys = new Set<string>();
  const refreshedIdentityKeys = new Set<string>();
  for (const page of chunked(items, LISTING_REVISION_BATCH_SIZE)) {
    const result = await scopedDb(async (tx) => {
      if (!(await hasReconciliationLease(tx, { sourceId, leaseToken }))) {
        return { outcome: "superseded" as const };
      }
      const incoming = new Map(page.map((item) => [item.identityKey, item]));
      const rows = await tx
        .select({
          id: caseLawReconciliationItems.id,
          identityKey: caseLawReconciliationItems.identityKey,
          slice: caseLawReconciliationItems.slice,
          status: caseLawReconciliationItems.status,
          revivalCount: caseLawReconciliationItems.revivalCount,
          payloadHash: caseLawReconciliationItems.payloadHash,
          rawPayloadChanged: sql<boolean>`${caseLawReconciliationItems.payload} IS DISTINCT FROM incoming.payload`,
          payload: sql<unknown>`CASE WHEN ${caseLawReconciliationItems.payloadHash} IS NULL THEN ${caseLawReconciliationItems.payload} ELSE NULL END`,
        })
        .from(caseLawReconciliationItems)
        .innerJoin(
          sql`jsonb_to_recordset(${JSON.stringify(page)}::text::jsonb) AS incoming("identityKey" text, payload jsonb)`,
          sql`${caseLawReconciliationItems.identityKey} = incoming."identityKey"`,
        )
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            inArray(
              caseLawReconciliationItems.identityKey,
              page.map(({ identityKey }) => identityKey),
            ),
          ),
        )
        .for("update", { of: caseLawReconciliationItems })
        .limit(page.length);
      const updates = [];
      const refreshed: string[] = [];
      for (const row of rows) {
        const item = incoming.get(row.identityKey);
        if (item === undefined) {
          return panic("Tracked revision was not in its listing batch");
        }
        const payloadHash = fingerprintReconciliationPayload(
          revisionOf(item.payload),
        );
        const changed =
          (row.payloadHash ??
            fingerprintReconciliationPayload(revisionOf(row.payload))) !==
          payloadHash;
        const revived =
          changed &&
          (row.status !== RECONCILIATION_ITEM_STATUS.TERMINAL ||
            row.revivalCount < RECONCILIATION_MAX_REVIVALS);
        if (revived) {
          refreshed.push(row.identityKey);
        }
        if (
          changed ||
          row.rawPayloadChanged ||
          row.payloadHash === null ||
          row.slice !== item.slice
        ) {
          updates.push({
            id: row.id,
            slice: item.slice,
            payload: item.payload,
            payload_hash: payloadHash,
            expected_hash: row.payloadHash,
            disposition: revived ? "revived" : "retained",
          });
        }
      }
      if (updates.length > 0) {
        const updated = executedRows(
          await tx.execute(sql`
        UPDATE ${caseLawReconciliationItems} AS tracked
        SET slice = incoming.slice, payload = incoming.payload, payload_hash = incoming.payload_hash,
          status = CASE WHEN incoming.disposition = 'revived' THEN 'parked' ELSE tracked.status END,
          revival_count = CASE WHEN incoming.disposition = 'revived' AND tracked.status = 'terminal' THEN tracked.revival_count + 1 ELSE tracked.revival_count END,
          next_attempt_at = CASE WHEN incoming.disposition = 'revived' THEN ${now}::timestamptz ELSE tracked.next_attempt_at END,
          last_error = CASE WHEN incoming.disposition = 'revived' THEN NULL ELSE tracked.last_error END,
          last_attempt_at = CASE WHEN incoming.disposition = 'revived' THEN NULL ELSE tracked.last_attempt_at END
        FROM jsonb_to_recordset(${JSON.stringify(updates)}::text::jsonb)
          AS incoming(id uuid, slice text, payload jsonb, payload_hash text, expected_hash text, disposition text)
        WHERE tracked.id = incoming.id AND tracked.source_id = ${sourceId}
          AND tracked.payload_hash IS NOT DISTINCT FROM incoming.expected_hash
        RETURNING tracked.id
      `),
        );
        if (updated.length !== updates.length) {
          return panic(
            "Locked reconciliation listing revision changed during refresh",
          );
        }
      }
      return {
        outcome: "refreshed" as const,
        tracked: rows.map(({ identityKey }) => identityKey),
        refreshed,
      };
    });
    if (result.outcome === "superseded") {
      return result;
    }
    for (const key of result.tracked) {
      trackedIdentityKeys.add(key);
    }
    for (const key of result.refreshed) {
      refreshedIdentityKeys.add(key);
    }
  }
  return { outcome: "refreshed", trackedIdentityKeys, refreshedIdentityKeys };
};

export type PruneUnlistedTerminalItemsInput = ReconciliationLease & {
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
type PruneUnlistedTerminalItemsResult =
  | { outcome: "superseded" }
  | { outcome: "pruned"; removed: number };

export const pruneUnlistedTerminalItems = async (
  scopedDb: ScopedDb,
  {
    sourceId,
    leaseToken,
    slice,
    listedIdentityKeys,
    limit,
  }: PruneUnlistedTerminalItemsInput,
): Promise<PruneUnlistedTerminalItemsResult> =>
  await scopedDb(async (tx) => {
    if (!(await hasReconciliationLease(tx, { sourceId, leaseToken }))) {
      return { outcome: "superseded" as const };
    }
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
      return { outcome: "pruned" as const, removed: 0 };
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
    return { outcome: "pruned" as const, removed: removed.length };
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

export type ReconciliationItemListing = {
  slice: string;
  identityKey: string;
  status: ReconciliationItemStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  firstSeenAt: Date;
  lastAttemptAt: Date | null;
};

export type ListReconciliationItemsInput = {
  sourceId: SafeId<"caseLawSource">;
  /** Rows returned per call. Bounds the read on a source with many items. */
  limit: number;
  /** Narrow to one slice, the same way a reset does. */
  slice?: string | undefined;
  /** Resume after this identity key; see the ordering note below. */
  after?: string | undefined;
};

/**
 * What one source is still carrying, for an operator deciding whether a
 * terminal reset is warranted.
 *
 * Ordered by identity key, and paged on it. That is not a presentation
 * choice: `(source_id, identity_key)` is the table's unique index, so the key
 * is the one column that totally orders a source's rows and never repeats,
 * which makes it the only cursor that can page a backlog without skipping or
 * repeating a row. `first_seen_at` would read better as "oldest first" and
 * cannot page — it is not unique, and comparing a truncated timestamp against
 * a boundary is the bug class this repo has a lint rule for. It is returned on
 * every row instead, so age stays visible.
 *
 * No payload: the listing item is the publisher's own record, and an operator
 * asking which identities are stuck does not need its contents. Bounded like
 * every other read here, so a source with a bad week cannot be listed whole.
 */
export const listReconciliationItems = async (
  scopedDb: ScopedDb,
  { sourceId, limit, slice, after }: ListReconciliationItemsInput,
): Promise<ReconciliationItemListing[]> =>
  await scopedDb(
    async (tx) =>
      await tx
        .select({
          slice: caseLawReconciliationItems.slice,
          identityKey: caseLawReconciliationItems.identityKey,
          status: caseLawReconciliationItems.status,
          attempts: caseLawReconciliationItems.attempts,
          nextAttemptAt: caseLawReconciliationItems.nextAttemptAt,
          lastError: caseLawReconciliationItems.lastError,
          firstSeenAt: caseLawReconciliationItems.firstSeenAt,
          lastAttemptAt: caseLawReconciliationItems.lastAttemptAt,
        })
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            ...(slice === undefined
              ? []
              : [eq(caseLawReconciliationItems.slice, slice)]),
            ...(after === undefined
              ? []
              : [gt(caseLawReconciliationItems.identityKey, after)]),
          ),
        )
        .orderBy(caseLawReconciliationItems.identityKey)
        .limit(limit),
  );

export type ResetTerminalReconciliationItemsInput = {
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  limit: number;
  /**
   * Narrow the reset to one slice. An operator who fixed one publisher's bad
   * day should be able to re-hunt that day without also re-hunting every
   * identity the adapter has ever retired.
   */
  slice?: string | undefined;
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
  { sourceId, now, limit, slice }: ResetTerminalReconciliationItemsInput,
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
          ...(slice === undefined
            ? []
            : [eq(caseLawReconciliationItems.slice, slice)]),
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
