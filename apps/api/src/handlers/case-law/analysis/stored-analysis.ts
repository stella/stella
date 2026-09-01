/**
 * What a stored decision analysis is worth for the document as it reads
 * now, and which rows a new generation run may take. Pure over the row's
 * `analysis` value and the current input fingerprint; the store in
 * `generate.ts` applies these against Postgres or memory.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";

import type {
  AnalysisGenerating,
  AnalysisInputFingerprint,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";
import { parsePersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * How long a run's sentinel holds the row. A run that dies without
 * clearing it (a process restart mid-generation) leaves the sentinel
 * behind; past this age another run may take the row over.
 */
export const SENTINEL_STALE_MS = 5 * 60 * 1000;

export const analysisSentinel = (
  fingerprint: AnalysisInputFingerprint,
  now: Date,
): AnalysisGenerating => ({
  version: 2,
  status: "generating",
  startedAt: now.toISOString(),
  inputFingerprint: fingerprint,
});

/**
 * A finished analysis over the same input, a run still in flight over the
 * same input, or nothing. A value over any other input is stale, whatever
 * its shape: its anchors name blocks of a document that no longer exists.
 */
export type StoredAnalysisState =
  | { kind: "done"; analysis: DecisionAnalysis }
  | { kind: "generating" }
  | { kind: "none" };

export const storedAnalysisState = ({
  fingerprint,
  now,
  stored,
}: {
  stored: unknown;
  fingerprint: AnalysisInputFingerprint;
  now: Date;
}): StoredAnalysisState => {
  const analysis = parsePersistedDecisionAnalysis(stored);
  if (analysis === null || analysis.inputFingerprint !== fingerprint) {
    return { kind: "none" };
  }
  if (!("status" in analysis)) {
    return { kind: "done", analysis };
  }
  const startedAt = new Date(analysis.startedAt).getTime();
  return now.getTime() - startedAt < SENTINEL_STALE_MS
    ? { kind: "generating" }
    : { kind: "none" };
};

export type AnalysisStoreKey = {
  decisionId: SafeId<"caseLawDecision">;
  fingerprint: AnalysisInputFingerprint;
};

export const storedAnalysisFingerprint = sql`${caseLawDecisions.analysis}->>'inputFingerprint'`;

/**
 * The rows a run over `fingerprint` may take: no analysis, an analysis or
 * sentinel over another input (stale, whatever its shape), or a sentinel
 * over this input that has outlived `SENTINEL_STALE_MS`. The SQL twin of
 * `storedAnalysisState` reading `none`, decided in the UPDATE itself so
 * two requests cannot both read a claimable row and both start a run.
 */
export const claimableAnalysisRow = ({
  decisionId,
  fingerprint,
  now,
}: AnalysisStoreKey & { now: Date }) => {
  // Both sides are `toISOString()` output, so text order is time order.
  const staleBefore = new Date(now.getTime() - SENTINEL_STALE_MS).toISOString();
  return and(
    eq(caseLawDecisions.id, decisionId),
    or(
      isNull(caseLawDecisions.analysis),
      sql`${storedAnalysisFingerprint} IS DISTINCT FROM ${fingerprint}`,
      and(
        sql`${caseLawDecisions.analysis}->>'status' = 'generating'`,
        sql`${caseLawDecisions.analysis}->>'startedAt' < ${staleBefore}`,
      ),
    ),
  );
};
