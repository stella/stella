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

import { and, eq, sql } from "drizzle-orm";

import type {
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
};

type AnalysisRelease = {
  decisionId: SafeId<"caseLawDecision">;
  /** The sentinel `claim` returned to this run. */
  sentinel: AnalysisGenerating;
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
   */
  save: (save: AnalysisSave) => Promise<void>;
  /**
   * Releases this run's sentinel, and only this run's: the exact value
   * `claim` wrote. A replacement run that took over this one's stale
   * sentinel holds a different value and is left alone.
   */
  clear: (release: AnalysisRelease) => Promise<void>;
  /** What the store holds beside the row; null where the row is the store. */
  peek: (decisionId: SafeId<"caseLawDecision">) => unknown;
};

/**
 * The row-backed store. Its three statements touch one column of one table,
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
  save: async ({ analysis, contentHash, decisionId }) => {
    // audit: skip — the caller audits the analysis it saves
    await db
      .update(caseLawDecisions)
      .set({ analysis })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          sql`${storedAnalysisFingerprint} = ${analysis.inputFingerprint}`,
          sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${contentHash}`,
        ),
      );
  },
  clear: async ({ decisionId, sentinel }) => {
    // audit: skip — analysis sentinel cleanup; no user-facing state change
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
  },
  peek: () => null,
});
