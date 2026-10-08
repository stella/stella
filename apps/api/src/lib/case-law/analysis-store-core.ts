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
  AnalysisFailed,
  AnalysisGenerating,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import {
  analysisSentinel,
  claimableAnalysisRow,
  storedAnalysisFingerprint,
  type AnalysisStoreKey,
} from "./stored-analysis";

/**
 * The one Drizzle capability the store needs. Structural rather than a
 * concrete handle, so a script's own connection satisfies it without the
 * store reaching for the application's.
 */
export type AnalysisRowWriter = Pick<Transaction, "update">;

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

type AnalysisFailure = AnalysisRelease & {
  /** Over the sentinel's own input, which the store does not re-derive. */
  failure: AnalysisFailed;
};

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
   * Replaces this run's sentinel, and only this run's, with the record of
   * how it failed, so a reader polling the run learns it ended and why
   * instead of finding the row empty and starting it again. Answers whether
   * the row still held the sentinel; when it did not, a newer run owns the
   * row and keeps it.
   */
  fail: (failure: AnalysisFailure) => Promise<boolean>;
  /** What the store holds beside the row; null where the row is the store. */
  peek: (decisionId: SafeId<"caseLawDecision">) => unknown;
};

/**
 * How a run gives the row back: its exact sentinel, and only that, becomes
 * nothing (the run was released) or the record of how it failed. A
 * replacement run that took over a stale sentinel holds a different value
 * and is left alone.
 */
const replaceSentinel = async (
  db: AnalysisRowWriter,
  {
    decisionId,
    sentinel,
    value,
  }: AnalysisRelease & { value: AnalysisFailed | null },
): Promise<boolean> => {
  // audit: skip — analysis sentinel release or outcome; no user-facing record changes
  const written = await db
    .update(caseLawDecisions)
    .set({ analysis: value })
    .where(
      and(
        eq(caseLawDecisions.id, decisionId),
        // `::text::jsonb`, never a bare `::jsonb` (see `claimableAnalysisRow`).
        sql`${caseLawDecisions.analysis} = ${JSON.stringify(sentinel)}::text::jsonb`,
      ),
    )
    .returning({ id: caseLawDecisions.id });
  return written.length > 0;
};

/**
 * The row-backed store. Its statements touch one column of one table,
 * which is exactly what the restricted analysis-writer role is granted.
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
    await replaceSentinel(db, { decisionId, sentinel, value: null });
  },
  fail: async ({ decisionId, failure, sentinel }) => {
    if (failure.inputFingerprint !== sentinel.inputFingerprint) {
      return panic("A failure record must be over its run's own input");
    }
    return await replaceSentinel(db, { decisionId, sentinel, value: failure });
  },
  peek: () => null,
});
