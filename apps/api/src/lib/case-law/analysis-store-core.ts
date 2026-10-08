/**
 * The row a decision analysis lives in, and the compare-and-swap that takes
 * it. Pure over a Drizzle handle: no env, no connection of its own, so the
 * API's background generation and an operator script running under a
 * restricted login both write through exactly the same statements.
 *
 * Every write is keyed by the input fingerprint as well as the decision:
 * the row may have been re-parsed since a run began, and a run's result or
 * sentinel cleanup must then leave the newer parse's state alone.
 */

import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type {
  AnalysisGenerating,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { Transaction } from "@/api/db/root";
import { caseLawAnalysisFailures, caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import {
  ANALYSIS_FAILURE_HOLD_MS,
  type AnalysisFailureRecord,
} from "./analysis-failure";
import {
  analysisSentinel,
  claimableAnalysisRow,
  storedAnalysisFingerprint,
  type AnalysisStoreKey,
} from "./stored-analysis";

/**
 * The Drizzle capabilities the store needs. Structural rather than a
 * concrete handle, so a script's own connection satisfies it without the
 * store reaching for the application's.
 */
export type AnalysisRowWriter = Pick<
  Transaction,
  "delete" | "insert" | "select" | "update"
>;

type AnalysisClaim = AnalysisStoreKey & {
  /** The stored value this caller read and found wanting; see `claimableAnalysisRow`. */
  observed: unknown;
};

type AnalysisSave = {
  decisionId: SafeId<"caseLawDecision">;
  analysis: DecisionAnalysis;
  /** The row's `contentHash` when the run was claimed. */
  contentHash: string | null;
  /**
   * The `analysis` value this run read, when the write must replace that
   * exact value and no other. The fingerprint fence alone cannot separate
   * two runs over the same document, so a writer that computed from
   * something beside the document (the citation graph) passes what it saw
   * and loses the race rather than overwriting a fresher result.
   */
  expected?: unknown;
};

type AnalysisRelease = {
  decisionId: SafeId<"caseLawDecision">;
  /** The sentinel `claim` returned to this run. */
  sentinel: AnalysisGenerating;
};

type AnalysisFailureKey = {
  decisionId: SafeId<"caseLawDecision">;
  /** The reader key the failure is filed under (`analysisFailureKeyTag`). */
  keyTag: string;
};

type AnalysisFailure = AnalysisRelease & {
  keyTag: string;
  /** Over the sentinel's own input, which the store does not re-derive. */
  failure: AnalysisFailureRecord;
};

/**
 * Expired failure records swept by each failure write, oldest first: enough
 * to keep pace with the writes that add them, bounded so a write never scans.
 */
const FAILURE_SWEEP_BATCH = 50;

export type AnalysisStore = {
  /**
   * Takes the row for a run over `fingerprint`, provided it still holds
   * `observed`. Returns the sentinel it wrote, which is the run's
   * identity from here on; null when another writer got there first.
   */
  claim: (claim: AnalysisClaim) => Promise<AnalysisGenerating | null>;
  /**
   * Stores the result, only where the row still carries this run's
   * fingerprint and the document it was claimed under. A re-parse during
   * the run changes `contentHash`; the result would then be rejected by
   * the next read anyway, so it is not worth the write.
   *
   * Answers whether a row was actually written. A caller that reports its
   * own success must ask: the fences are `WHERE` clauses, so a row that
   * moved between the claim and the save is a silent no-op otherwise.
   */
  save: (save: AnalysisSave) => Promise<boolean>;
  /**
   * Releases this run's sentinel, and only this run's: the exact value
   * `claim` wrote. A replacement run that took over this one's stale
   * sentinel holds a different value and is left alone.
   */
  clear: (release: AnalysisRelease) => Promise<void>;
  /**
   * Records how this run failed under its reader's key, then releases its
   * sentinel. The record sits apart from the shared row, so another reader's
   * run on the same decision neither replaces nor clears it: the reader whose
   * key failed is told so until it asks to run again, while every other
   * reader runs with its own key.
   */
  fail: (failure: AnalysisFailure) => Promise<void>;
  /** The failure last recorded under this reader key, if any. */
  readFailure: (
    key: AnalysisFailureKey,
  ) => Promise<AnalysisFailureRecord | null>;
  /** What the store holds beside the row; null where the row is the store. */
  peek: (decisionId: SafeId<"caseLawDecision">) => unknown;
};

/**
 * How a run gives the row back: its exact sentinel, and only that, becomes
 * nothing. A replacement run that took over a stale sentinel holds a
 * different value and is left alone. A failed run first files its failure
 * under its reader key (sweeping a bounded batch of expired records), so a
 * poll between the two statements still sees the sentinel, never a row with
 * neither.
 */
const releaseRun = async (
  db: AnalysisRowWriter,
  {
    decisionId,
    sentinel,
    failure,
  }: AnalysisRelease & {
    failure?: { keyTag: string; record: AnalysisFailureRecord } | undefined;
  },
): Promise<void> => {
  // audit: skip — analysis run bookkeeping; no user-facing record changes
  if (failure !== undefined) {
    const { keyTag, record } = failure;
    await db
      .insert(caseLawAnalysisFailures)
      .values({ decisionId, keyTag, ...record })
      .onConflictDoUpdate({
        target: [
          caseLawAnalysisFailures.decisionId,
          caseLawAnalysisFailures.keyTag,
        ],
        set: record,
      });
    const expiredBefore = new Date(
      record.recordedAt.getTime() - ANALYSIS_FAILURE_HOLD_MS,
    );
    await db
      .delete(caseLawAnalysisFailures)
      .where(
        sql`(${caseLawAnalysisFailures.decisionId}, ${caseLawAnalysisFailures.keyTag}) IN (SELECT "decision_id", "key_tag" FROM "case_law_analysis_failures" WHERE "recorded_at" < ${expiredBefore.toISOString()}::timestamptz ORDER BY "recorded_at" LIMIT ${FAILURE_SWEEP_BATCH})`,
      );
  }
  await db
    .update(caseLawDecisions)
    .set({ analysis: null })
    .where(
      and(
        eq(caseLawDecisions.id, decisionId),
        // `::text::jsonb`, never a bare `::jsonb` (see `claimableAnalysisRow`).
        sql`${caseLawDecisions.analysis} = ${JSON.stringify(sentinel)}::text::jsonb`,
      ),
    );
};

/**
 * The row-backed store. Its claim, save and release touch one column of one
 * table, which is exactly what the restricted analysis-writer role is
 * granted; only a failed run's record reaches a second table, which only the
 * owner connection that runs the analysis may write.
 */
export const createDbAnalysisStore = (
  db: AnalysisRowWriter,
): AnalysisStore => ({
  claim: async ({ decisionId, fingerprint, observed }) => {
    // audit: skip — analysis sentinel; the caller audits the analysis it saves
    const sentinel = analysisSentinel(fingerprint, new Date());
    const [updated] = await db
      .update(caseLawDecisions)
      .set({ analysis: sentinel })
      .where(claimableAnalysisRow({ decisionId, observed }))
      .returning({ id: caseLawDecisions.id });
    return updated === undefined ? null : sentinel;
  },
  save: async ({ analysis, contentHash, decisionId, expected }) => {
    // audit: skip — the caller audits the analysis it saves
    const written = await db
      .update(caseLawDecisions)
      .set({ analysis })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          sql`${storedAnalysisFingerprint} = ${analysis.inputFingerprint}`,
          sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${contentHash}`,
          ...(expected === undefined
            ? []
            : // `::text::jsonb`, never a bare `::jsonb` (see `claimableAnalysisRow`).
              [
                sql`${caseLawDecisions.analysis} = ${JSON.stringify(expected)}::text::jsonb`,
              ]),
        ),
      )
      .returning({ id: caseLawDecisions.id });
    return written.length > 0;
  },
  clear: async ({ decisionId, sentinel }) => {
    await releaseRun(db, { decisionId, sentinel });
  },
  fail: async ({ decisionId, failure, keyTag, sentinel }) => {
    if (failure.inputFingerprint !== sentinel.inputFingerprint) {
      return panic("A failure record must be over its run's own input");
    }
    await releaseRun(db, {
      decisionId,
      sentinel,
      failure: { keyTag, record: failure },
    });
  },
  readFailure: async ({ decisionId, keyTag }) => {
    const [row] = await db
      .select({
        code: caseLawAnalysisFailures.code,
        inputFingerprint: caseLawAnalysisFailures.inputFingerprint,
        keySource: caseLawAnalysisFailures.keySource,
        provider: caseLawAnalysisFailures.provider,
        recordedAt: caseLawAnalysisFailures.recordedAt,
      })
      .from(caseLawAnalysisFailures)
      .where(
        and(
          eq(caseLawAnalysisFailures.decisionId, decisionId),
          eq(caseLawAnalysisFailures.keyTag, keyTag),
        ),
      )
      .limit(1);
    return row ?? null;
  },
  peek: () => null,
});
