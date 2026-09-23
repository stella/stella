import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";

import { Temporal, DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
  caseLawRawSweeps,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  classifyCaseLawRawKey,
  deleteRawKeys,
  eraseRawDocument,
  isRawPayloadKey,
  listRawDocumentKeys,
  RAW_KEY_OWNERSHIP,
  RAW_SOURCE_ERASURE_SETTLE_MS,
  RAW_SOURCE_FAMILY,
  rawDocumentPrefix,
  readRawPayloadRefs,
} from "@/api/lib/legal-search/raw-source-storage";

/**
 * The erasure side of per-decision raw storage.
 *
 * A decision's raw objects live under its own prefix, so erasing them is
 * deleting that prefix, and what decides whether a prefix may be deleted is
 * the state of the one row it belongs to: erased, or never written. A live
 * decision's prefix is never touched here, whatever asked for the sweep.
 *
 * Objects in the layout that came before (one content-addressed key per
 * source, shared by every decision served the same bytes) cannot be deleted
 * for one decision on its word alone. They are deleted once no live
 * decision of the source names a key of that layout at all, which is the
 * state the layout backfill converges every source to.
 */

type CaseLawRawOwner = {
  decisionId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
};

const documentOwner = ({ decisionId, sourceId }: CaseLawRawOwner) => ({
  family: RAW_SOURCE_FAMILY.CASE_LAW,
  sourceId,
  documentId: decisionId,
});

type EnqueueCaseLawRawSweepOptions = CaseLawRawOwner & {
  /** When the sweeper first looks at the entry. */
  firstAttemptAt: Date;
  /** Before this, the entry is not retired, however clean the prefix. */
  settleAfter: Date;
  legacyPayloadKeys?: readonly string[];
};

/**
 * Record that a decision's raw prefix is owed a sweep, in the transaction
 * that learned it. Merges with an entry already there: the earliest attempt,
 * the latest settle time and every legacy key either named.
 */
export const enqueueCaseLawRawSweepTx = async (
  tx: Transaction,
  {
    decisionId,
    sourceId,
    firstAttemptAt,
    settleAfter,
    legacyPayloadKeys = [],
  }: EnqueueCaseLawRawSweepOptions,
): Promise<void> => {
  // audit: skip — erasure bookkeeping; the erasure itself is audited in
  // case_law_index_jobs by its caller
  await tx
    .insert(caseLawRawSweeps)
    .values({
      decisionId,
      sourceId,
      legacyPayloadKeys: [...legacyPayloadKeys],
      settleAfter,
      nextAttemptAt: firstAttemptAt,
    })
    .onConflictDoUpdate({
      target: caseLawRawSweeps.decisionId,
      set: {
        legacyPayloadKeys: sql`ARRAY(SELECT DISTINCT unnest(${caseLawRawSweeps.legacyPayloadKeys} || excluded.legacy_payload_keys))`,
        settleAfter: sql`GREATEST(${caseLawRawSweeps.settleAfter}, excluded.settle_after)`,
        nextAttemptAt: sql`LEAST(${caseLawRawSweeps.nextAttemptAt}, excluded.next_attempt_at)`,
      },
    });
};

/** A settle time counted from now. */
export const rawSweepSettleAfter = (): Date =>
  new Date(
    Temporal.Now.instant().epochMilliseconds + RAW_SOURCE_ERASURE_SETTLE_MS,
  );

/** Which state of its decision a raw prefix is in. */
export const RAW_PREFIX_STATE = {
  /** A row that is not erased owns it: never swept. */
  LIVE: "live",
  /**
   * No row, but a publisher identity reserves the id for one: a retry of
   * the insert may still land under it.
   */
  RESERVED: "reserved",
  /** An erased row: nothing may keep it. */
  ERASED: "erased",
  /** No row and no reservation: nothing will ever own it. */
  ORPHANED: "orphaned",
} as const;

export type RawPrefixState =
  (typeof RAW_PREFIX_STATE)[keyof typeof RAW_PREFIX_STATE];

/** The state of every named decision, in two indexed reads. */
export const readRawPrefixStates = async (
  tx: Transaction,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<Map<SafeId<"caseLawDecision">, RawPrefixState>> => {
  const states = new Map<SafeId<"caseLawDecision">, RawPrefixState>();
  if (decisionIds.length === 0) {
    return states;
  }
  const rows = await tx
    .select({
      id: caseLawDecisions.id,
      redactedAt: caseLawDecisions.redactedAt,
    })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...decisionIds]));
  const reserved = await tx
    .selectDistinct({ decisionId: caseLawDecisionSourceIdentities.decisionId })
    .from(caseLawDecisionSourceIdentities)
    .where(
      inArray(caseLawDecisionSourceIdentities.decisionId, [...decisionIds]),
    );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const reservedIds = new Set(reserved.map(({ decisionId }) => decisionId));
  for (const decisionId of decisionIds) {
    const row = rowById.get(decisionId);
    if (row !== undefined) {
      states.set(
        decisionId,
        row.redactedAt === null
          ? RAW_PREFIX_STATE.LIVE
          : RAW_PREFIX_STATE.ERASED,
      );
    } else {
      states.set(
        decisionId,
        reservedIds.has(decisionId)
          ? RAW_PREFIX_STATE.RESERVED
          : RAW_PREFIX_STATE.ORPHANED,
      );
    }
  }
  return states;
};

/**
 * Whether a live decision of the source still names a legacy key.
 *
 * A legacy object is shared by content, so the only way to know nothing
 * live needs one is that nothing live names that layout at all: a row's
 * pointer names its payload, and the payload names its files, and a row
 * whose pointer is under its own prefix has had its files moved there too
 * (the write and the layout backfill both copy them in before they point
 * the row at the payload). Scoped to one source's rows through its index.
 */
export const sourceHasLiveLegacyReferences = async (
  tx: Transaction,
  {
    sourceId,
    exceptDecisionId,
  }: {
    sourceId: SafeId<"caseLawSource">;
    /** A decision being erased, whose own row no longer counts. */
    exceptDecisionId?: SafeId<"caseLawDecision">;
  },
): Promise<boolean> => {
  const ownPrefix = sql`${`${RAW_SOURCE_FAMILY.CASE_LAW}/raw/`} || ${caseLawDecisions.sourceId}::text || '/documents/' || ${caseLawDecisions.id}::text || '/%'`;
  const found = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, sourceId),
        exceptDecisionId === undefined
          ? undefined
          : ne(caseLawDecisions.id, exceptDecisionId),
        isNull(caseLawDecisions.redactedAt),
        sql`${caseLawDecisions.sourceRawS3Key} IS NOT NULL`,
        sql`${caseLawDecisions.sourceRawS3Key} NOT LIKE ${ownPrefix}`,
      ),
    )
    .limit(1);
  return found.length > 0;
};

export type CaseLawRawSweepOutcome =
  | { type: typeof RAW_PREFIX_STATE.LIVE }
  | { type: typeof RAW_PREFIX_STATE.RESERVED }
  | {
      type: "swept";
      /** Whether legacy objects this decision named are still stored. */
      legacy: "none" | "erased" | "pending";
    };

type SweepCaseLawRawDecisionOptions = CaseLawRawOwner & {
  scopedDb: ScopedDb;
  signal: AbortSignal;
};

/** A key list as one SQL array value rather than a parameter list. */
const varcharArray = (keys: readonly string[]) =>
  sql`ARRAY[${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  )}]::varchar[]`;

const legacyOf = (keys: readonly string[], owner: CaseLawRawOwner): string[] =>
  keys.filter(
    (key) =>
      classifyCaseLawRawKey(key, {
        sourceId: owner.sourceId,
        documentId: owner.decisionId,
      }) === RAW_KEY_OWNERSHIP.LEGACY,
  );

/**
 * Sweep one decision's raw objects, if its state allows it: the one path
 * that deletes a decision's raw prefix, shared by the erasure and by the
 * sweeper that follows it up.
 *
 * The order is what makes it safe to repeat from any point: the legacy files
 * the decision's payloads name are recorded before any payload is deleted,
 * and legacy payloads go only after the files they name. The entry is
 * retired only once nothing is pending and its settle time has passed.
 */
export const sweepCaseLawRawDecision = async ({
  scopedDb,
  signal,
  ...owner
}: SweepCaseLawRawDecisionOptions): Promise<CaseLawRawSweepOutcome> => {
  const { decisionId } = owner;
  const state = await scopedDb(
    async (tx) =>
      (await readRawPrefixStates(tx, [decisionId])).get(decisionId) ??
      panic("Raw prefix state lost"),
  );
  if (state === RAW_PREFIX_STATE.LIVE || state === RAW_PREFIX_STATE.RESERVED) {
    // Nothing here is this entry's to delete. The entry goes: whatever
    // queued it has been overtaken by a row that owns the prefix, or by a
    // reservation whose insert will.
    await scopedDb(async (tx) => {
      await tx
        .delete(caseLawRawSweeps)
        .where(eq(caseLawRawSweeps.decisionId, decisionId));
    });
    return { type: state };
  }

  const entry = await scopedDb(
    async (tx) =>
      (
        await tx
          .select({
            legacyPayloadKeys: caseLawRawSweeps.legacyPayloadKeys,
            legacyFileKeys: caseLawRawSweeps.legacyFileKeys,
          })
          .from(caseLawRawSweeps)
          .where(eq(caseLawRawSweeps.decisionId, decisionId))
      ).at(0) ?? { legacyPayloadKeys: [], legacyFileKeys: [] },
  );

  // Before anything is deleted: every legacy file a payload of this
  // decision names, so a payload is never gone before what it named is
  // recorded.
  const document = documentOwner(owner);
  const ownPayloadKeys = (
    await listRawDocumentKeys({ ...document, signal })
  ).filter((key) => isRawPayloadKey(key, document));
  const named = await Promise.all(
    [...ownPayloadKeys, ...entry.legacyPayloadKeys].map(
      async (key) => await readRawPayloadRefs(key, signal),
    ),
  );
  const namedLegacyFiles = legacyOf(
    named.flat().map(({ location }) => location),
    owner,
  );
  const legacyFileKeys = [
    ...new Set([...entry.legacyFileKeys, ...namedLegacyFiles]),
  ];
  if (legacyFileKeys.length > entry.legacyFileKeys.length) {
    await scopedDb(async (tx) => {
      await tx
        .insert(caseLawRawSweeps)
        .values({
          decisionId,
          sourceId: owner.sourceId,
          legacyPayloadKeys: entry.legacyPayloadKeys,
          legacyFileKeys,
          settleAfter: rawSweepSettleAfter(),
          nextAttemptAt: new Date(),
        })
        .onConflictDoUpdate({
          target: caseLawRawSweeps.decisionId,
          set: {
            legacyFileKeys: sql`ARRAY(SELECT DISTINCT unnest(${caseLawRawSweeps.legacyFileKeys} || excluded.legacy_file_keys))`,
          },
        });
    });
  }

  await eraseRawDocument({ ...document, signal });

  const legacyPayloadKeys = legacyOf(entry.legacyPayloadKeys, owner);
  const legacyFiles = legacyOf(legacyFileKeys, owner);
  let legacy: "none" | "erased" | "pending" = "none";
  if (legacyPayloadKeys.length > 0 || legacyFiles.length > 0) {
    const shared = await scopedDb(
      async (tx) =>
        await sourceHasLiveLegacyReferences(tx, {
          sourceId: owner.sourceId,
          exceptDecisionId: decisionId,
        }),
    );
    if (shared) {
      legacy = "pending";
    } else {
      await deleteRawKeys(legacyFiles, signal);
      await deleteRawKeys(legacyPayloadKeys, signal);
      legacy = "erased";
    }
  }

  await scopedDb(async (tx) => {
    if (legacy === "erased") {
      // Exactly the keys deleted above: one a concurrent sweep recorded
      // since this one read the entry stays for the next attempt.
      await tx
        .update(caseLawRawSweeps)
        .set({
          legacyPayloadKeys: sql`ARRAY(SELECT unnest(${caseLawRawSweeps.legacyPayloadKeys}) EXCEPT SELECT unnest(${varcharArray(entry.legacyPayloadKeys)}))`,
          legacyFileKeys: sql`ARRAY(SELECT unnest(${caseLawRawSweeps.legacyFileKeys}) EXCEPT SELECT unnest(${varcharArray(legacyFileKeys)}))`,
        })
        .where(eq(caseLawRawSweeps.decisionId, decisionId));
    }
    await tx
      .delete(caseLawRawSweeps)
      .where(
        and(
          eq(caseLawRawSweeps.decisionId, decisionId),
          lte(caseLawRawSweeps.settleAfter, sql`now()`),
          sql`cardinality(${caseLawRawSweeps.legacyPayloadKeys}) = 0`,
          sql`cardinality(${caseLawRawSweeps.legacyFileKeys}) = 0`,
        ),
      );
  });
  return { type: "swept", legacy };
};

const RETRY_UNIT_MS = 60 * 1000;

type ReconcileCaseLawRawSweepsOptions = {
  scopedDb: ScopedDb;
  limit: number;
  signal: AbortSignal;
};

export type ReconcileCaseLawRawSweepsResult = {
  claimed: number;
  swept: number;
  failed: number;
  legacyPending: number;
};

/**
 * Drain due sweeps, bounded. Claiming pushes each entry's next attempt out
 * before any object is touched, with `SKIP LOCKED` so scheduler replicas
 * never take the same entry, and never earlier than its settle time: the
 * sweep after that is the one that may retire it.
 */
export const reconcileCaseLawRawSweeps = async ({
  scopedDb,
  limit,
  signal,
}: ReconcileCaseLawRawSweepsOptions): Promise<ReconcileCaseLawRawSweepsResult> => {
  if (!Number.isInteger(limit) || limit < 1) {
    return panic("Raw sweep limit must be a positive integer");
  }
  signal.throwIfAborted();
  const claimed = await scopedDb(async (tx) => {
    const rows = await tx
      .select({
        decisionId: caseLawRawSweeps.decisionId,
        sourceId: caseLawRawSweeps.sourceId,
      })
      .from(caseLawRawSweeps)
      .where(lte(caseLawRawSweeps.nextAttemptAt, sql`now()`))
      .orderBy(
        asc(caseLawRawSweeps.nextAttemptAt),
        asc(caseLawRawSweeps.decisionId),
      )
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(caseLawRawSweeps)
        .set({
          attemptCount: sql`${caseLawRawSweeps.attemptCount} + 1`,
          nextAttemptAt: sql`GREATEST(
            ${caseLawRawSweeps.settleAfter},
            now() + LEAST(
              ${DAY_IN_MS},
              ${RETRY_UNIT_MS} * POWER(2, LEAST(${caseLawRawSweeps.attemptCount}, 11))
            ) * interval '1 millisecond'
          )`,
        })
        .where(
          inArray(
            caseLawRawSweeps.decisionId,
            rows.map(({ decisionId }) => decisionId),
          ),
        );
    }
    return rows;
  });

  const result: ReconcileCaseLawRawSweepsResult = {
    claimed: claimed.length,
    swept: 0,
    failed: 0,
    legacyPending: 0,
  };
  const sweep = async (owner: CaseLawRawOwner) =>
    await Result.tryPromise({
      try: async () =>
        await sweepCaseLawRawDecision({ ...owner, scopedDb, signal }),
      catch: (cause) => cause,
    });
  for (const owner of claimed) {
    signal.throwIfAborted();
    // One sweep at a time keeps listings and deletes within the store's limits.
    const outcome = await sweep(owner);
    if (Result.isError(outcome)) {
      result.failed += 1;
      captureError(outcome.error, {
        decisionId: owner.decisionId,
        prefix: rawDocumentPrefix(documentOwner(owner)),
        step: "reconcileCaseLawRawSweeps.sweep",
      });
      continue;
    }
    if (outcome.value.type === "swept") {
      result.swept += 1;
      if (outcome.value.legacy === "pending") {
        result.legacyPending += 1;
      }
    }
  }
  return result;
};
