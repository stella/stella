/**
 * The drain of `case_law_ranking_signal_changes`: the decisions whose ranking
 * signals may have moved since their projection was derived, enqueued by the
 * database itself (an authority write that moved a bucket, a publication or
 * group-key change in a language group).
 *
 * A generation that stores the signals on every passage fingerprints them
 * (`case-law-ranking-signals.ts`), so such a decision needs its desired state
 * reconciled, and nothing else does that: the signals move without the
 * decision being edited. Reconciling a decision whose fingerprint did not
 * change writes nothing, so only real moves re-project.
 *
 * Two transactions per batch, in the writers' lock order. The claim leases a
 * bounded set of rows, so concurrent drains split the queue, and commits. The reconcile then locks each source's decisions the
 * way every canonical writer does, source policy first, and deletes the rows
 * it drained only where their change count is still the one it claimed: a
 * change enqueued meanwhile bumps the count and keeps the row for the next
 * drain. A drain that dies leaves its claim to lapse.
 */
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawRankingSignalChanges } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE,
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCaseLawProjectionBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

/** Rows one drain claims: one canonical repair batch. */
export const CASE_LAW_RANKING_SIGNAL_DRAIN_BATCH =
  CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE;

/** How long a claim holds before another drain may take the rows. */
export const CASE_LAW_RANKING_SIGNAL_CLAIM_MS = 120_000;

export type CaseLawRankingSignalDrain = {
  /** Rows this drain claimed. */
  claimed: number;
  /** Claimed decisions whose desired state was reconciled. */
  reconciled: number;
  /** Claimed rows naming a decision that no longer exists. */
  dropped: number;
  /** Claimed rows left for a later drain because a change arrived meanwhile. */
  requeued: number;
};

type ClaimedChange = {
  decisionId: SafeId<"caseLawDecision">;
  changeCount: bigint;
};

/**
 * Lease the oldest unclaimed rows. The claim condition is repeated on the
 * update itself: two drains that picked the same rows serialize on the row,
 * and the second rechecks it, finds the first one's lease and skips it.
 */
const claimChanges = async (
  tx: Transaction,
  limit: number,
): Promise<ClaimedChange[]> => {
  const changes = caseLawRankingSignalChanges;
  const unclaimed = or(
    isNull(changes.claimedUntil),
    lt(changes.claimedUntil, sql`now()`),
  );
  const claimable = tx
    .select({ decisionId: changes.decisionId })
    .from(changes)
    .where(unclaimed)
    .orderBy(asc(changes.enqueuedAt), asc(changes.decisionId))
    .limit(limit);
  // audit: skip - lease bookkeeping on a derived projection work queue
  const rows = await tx
    .update(changes)
    .set({
      claimedUntil: sql`now() + make_interval(secs => ${CASE_LAW_RANKING_SIGNAL_CLAIM_MS / 1000})`,
    })
    .where(and(inArray(changes.decisionId, claimable), unclaimed))
    .returning({
      decisionId: changes.decisionId,
      changeCount: changes.changeCount,
    });
  return rows.map(({ decisionId, changeCount }) => ({
    decisionId: brandPersistedCaseLawDecisionId(decisionId),
    changeCount,
  }));
};

/** Delete drained rows whose count is still the claimed one; return how many stayed. */
const releaseDrained = async (
  tx: Transaction,
  drained: readonly ClaimedChange[],
): Promise<number> => {
  if (drained.length === 0) {
    return 0;
  }
  const changes = caseLawRankingSignalChanges;
  // audit: skip - consumes drained rows of a derived projection work queue
  const deleted = await tx
    .delete(changes)
    .where(
      or(
        ...drained.map(({ decisionId, changeCount }) =>
          and(
            eq(changes.decisionId, decisionId),
            eq(changes.changeCount, changeCount),
          ),
        ),
      ),
    )
    .returning({ decisionId: changes.decisionId });
  return drained.length - deleted.length;
};

type DrainOptions = {
  runInTransaction: IngestionTransactionRunner<Transaction>;
  limit?: number;
};

/**
 * Drain one bounded batch. Returns what it did; a batch with nothing queued
 * claims nothing and costs one statement.
 */
export const drainCaseLawRankingSignalChanges = async ({
  runInTransaction,
  limit = CASE_LAW_RANKING_SIGNAL_DRAIN_BATCH,
}: DrainOptions): Promise<CaseLawRankingSignalDrain> => {
  const bounded = Math.min(
    Math.max(1, limit),
    CASE_LAW_RANKING_SIGNAL_DRAIN_BATCH,
  );
  const claimed = await runInTransaction(
    async (tx) => await claimChanges(tx, bounded),
  );
  const outcome: CaseLawRankingSignalDrain = {
    claimed: claimed.length,
    reconciled: 0,
    dropped: 0,
    requeued: 0,
  };
  if (claimed.length === 0) {
    return outcome;
  }
  const sources = await runInTransaction(
    async (tx) =>
      await tx
        .select({
          id: caseLawDecisions.id,
          sourceId: caseLawDecisions.sourceId,
        })
        .from(caseLawDecisions)
        .where(
          inArray(
            caseLawDecisions.id,
            claimed.map(({ decisionId }) => decisionId),
          ),
        )
        .limit(claimed.length),
  );
  const sourceOf = new Map(
    sources.map(({ id, sourceId }) => [String(id), sourceId]),
  );
  const bySource = new Map<SafeId<"caseLawSource">, ClaimedChange[]>();
  const gone: ClaimedChange[] = [];
  // A claimed decision the source read did not find was deleted since it was
  // queued: it is dropped below, counted in `dropped`.
  for (const change of claimed) {
    const sourceId = sourceOf.get(String(change.decisionId));
    if (sourceId === undefined) {
      gone.push(change);
    } else {
      const group = bySource.get(sourceId);
      if (group === undefined) {
        bySource.set(sourceId, [change]);
      } else {
        group.push(change);
      }
    }
  }
  // One transaction per source, in source order, as every canonical writer
  // takes one source's policy lock before its decisions.
  for (const [sourceId, changes] of [...bySource].toSorted(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    // db-await-in-loop: one transaction per source keeps the canonical lock order; the claim bounds the batch to one repair batch in total.
    outcome.requeued += await runInTransaction(async (tx) => {
      const lock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
        family: "case_law",
        sourceId,
      });
      if (lock !== null) {
        await synchronizeLockedCaseLawProjectionBatchTx(tx, {
          lock,
          sourceId,
          decisionIds: changes.map(({ decisionId }) => decisionId),
        });
      }
      return await releaseDrained(tx, changes);
    });
    outcome.reconciled += changes.length;
  }
  if (gone.length > 0) {
    outcome.requeued += await runInTransaction(
      async (tx) => await releaseDrained(tx, gone),
    );
    outcome.dropped = gone.length;
  }
  return outcome;
};
