import { panic, Result } from "better-result";
import { and, eq, isNull, or, sql } from "drizzle-orm";
/**
 * What a stored decision analysis is worth for the document as it reads
 * now, and how a new generation run takes the row. Pure over the row's
 * `analysis` value and the current input fingerprint; the stores in
 * `analysis-store.ts` apply these against Postgres or memory.
 */

import type {
  AnalysisFailed,
  AnalysisFailureCode,
  AnalysisFailureKey,
  AnalysisGenerating,
  AnalysisInputFingerprint,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";
import {
  CURRENT_ANALYSIS_VERSION,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

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
  version: CURRENT_ANALYSIS_VERSION,
  status: "generating",
  startedAt: now.toISOString(),
  inputFingerprint: fingerprint,
});

/**
 * How long a failed run's record answers for the decision. Within it, the
 * reader whose key failed is told why (and offered a retry) instead of the
 * next poll starting the same run again; past it, the next open of the
 * decision simply runs anew.
 */
export const ANALYSIS_FAILURE_HOLD_MS = 15 * 60 * 1000;

/**
 * The key a reader would run the analysis with, in the form a failure record
 * names it. An organization's key is named by a tag derived from the
 * organization and the decision, so each decision's record carries its own
 * tag.
 */
export type AnalysisReaderKey =
  | {
      source: "organization";
      organizationId: SafeId<"organization">;
      provider: string;
    }
  | { source: "platform" };

const organizationKeyTag = (
  organizationId: SafeId<"organization">,
  decisionId: SafeId<"caseLawDecision">,
): string =>
  sha256Hex(`case-law-analysis-failure:${organizationId}:${decisionId}`);

export const analysisFailureKey = (
  reader: AnalysisReaderKey,
  decisionId: SafeId<"caseLawDecision">,
): AnalysisFailureKey => {
  switch (reader.source) {
    case "organization":
      return {
        source: "organization",
        tag: organizationKeyTag(reader.organizationId, decisionId),
        provider: reader.provider,
      };
    case "platform":
      return { source: "platform" };
    default:
      reader satisfies never;
      return panic("Unhandled analysis reader key");
  }
};

export const analysisFailure = ({
  code,
  decisionId,
  fingerprint,
  now,
  reader,
}: {
  code: AnalysisFailureCode;
  decisionId: SafeId<"caseLawDecision">;
  fingerprint: AnalysisInputFingerprint;
  now: Date;
  reader: AnalysisReaderKey;
}): AnalysisFailed => ({
  version: CURRENT_ANALYSIS_VERSION,
  status: "failed",
  failedAt: now.toISOString(),
  inputFingerprint: fingerprint,
  code,
  key: analysisFailureKey(reader, decisionId),
});

/**
 * Whether a failure record answers this reader: only a reader calling with
 * the very key that failed. A platform failure says nothing about an
 * organization's own key and the reverse, and one organization's key failing
 * says nothing about another's, so every other reader reads it as no
 * analysis and runs with its own key.
 */
export const failureAnswersReader = ({
  decisionId,
  failure,
  reader,
}: {
  decisionId: SafeId<"caseLawDecision">;
  failure: AnalysisFailed;
  reader: AnalysisReaderKey;
}): boolean => {
  const key = failure.key;
  switch (key.source) {
    case "organization":
      return (
        reader.source === "organization" &&
        key.tag === organizationKeyTag(reader.organizationId, decisionId) &&
        key.provider === reader.provider
      );
    case "platform":
      return reader.source === "platform";
    default:
      key satisfies never;
      return panic("Unhandled analysis failure key");
  }
};

/**
 * A finished analysis over the same input, a run still in flight over the
 * same input, a run over the same input that failed recently, or nothing. A
 * value over any other input is stale, whatever its shape: its anchors name
 * blocks of a document that no longer exists. A value the parser rejects is
 * nothing too, whatever it claims, and so is a sentinel or failure record
 * past its hold.
 */
export type StoredAnalysisState =
  | { kind: "done"; analysis: DecisionAnalysis }
  | { kind: "generating" }
  | { kind: "failed"; failure: AnalysisFailed }
  | { kind: "none" };

const isFresh = (at: string, now: Date, holdMs: number): boolean => {
  const instant = Result.try(() => Temporal.Instant.from(at));
  return (
    instant.isOk() && now.getTime() - instant.value.epochMilliseconds < holdMs
  );
};

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
  switch (analysis.status) {
    case "generating":
      return isFresh(analysis.startedAt, now, SENTINEL_STALE_MS)
        ? { kind: "generating" }
        : { kind: "none" };
    case "failed":
      return isFresh(analysis.failedAt, now, ANALYSIS_FAILURE_HOLD_MS)
        ? { kind: "failed", failure: analysis }
        : { kind: "none" };
    default:
      analysis satisfies never;
      return panic("Unhandled persisted analysis status");
  }
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
