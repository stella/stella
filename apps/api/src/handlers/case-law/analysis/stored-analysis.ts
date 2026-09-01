/**
 * What a stored decision analysis is worth for the document as it reads
 * now, and how a new generation run takes the row. Pure over the row's
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
 * A value the parser rejects is nothing too, whatever it claims.
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
 * The row a run may take: the one that still holds exactly the value this
 * request read and classified as `none`. A compare-and-swap rather than a
 * SQL restatement of `storedAnalysisState`, so the two cannot disagree: a
 * value the parser rejects, a stale sentinel and a foreign fingerprint are
 * all claimable for the same reason, that the JavaScript reading said so
 * of this very value. Two requests that read the same value race on the
 * UPDATE and one loses; a row that changed underneath is left to the next
 * read. `jsonb` equality is structural, so the key order the driver
 * returned the value in does not matter.
 */
export const claimableAnalysisRow = ({
  decisionId,
  observed,
}: {
  decisionId: SafeId<"caseLawDecision">;
  /**
   * The `analysis` value this request read from the row, as read: it may
   * be a shape the parser rejected, which is one of the reasons to claim.
   */
  observed: unknown;
}) =>
  and(
    eq(caseLawDecisions.id, decisionId),
    observed === null || observed === undefined
      ? // The driver reads a JSON `null` in the column as JavaScript
        // `null` too, and SQL `IS NULL` does not see that one.
        or(
          isNull(caseLawDecisions.analysis),
          sql`jsonb_typeof(${caseLawDecisions.analysis}) = 'null'`,
        )
      : // `::text::jsonb`, never a bare `::jsonb`: the driver would encode
        // the already-serialised string once more and the comparison would
        // never match.
        sql`${caseLawDecisions.analysis} = ${JSON.stringify(observed)}::text::jsonb`,
  );
