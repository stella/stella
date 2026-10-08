/**
 * How a reader's last analysis run of a decision failed, and for how long
 * that answers the reader. Pure; `analysis-store-core.ts` keeps the records,
 * one per decision and reader key, apart from the decision row every reader
 * shares, so one reader's failure is never replaced by another reader's run.
 */

import { panic } from "better-result";

import type {
  CaseLawAnalysisFailureCode,
  CaseLawAnalysisKeySource,
} from "@stll/api-contract";
import type { AnalysisInputFingerprint } from "@stll/legal-ast/analysis";
import { sha256Hex } from "@stll/sha256/bun";

import type { SafeId } from "@/api/lib/branded-types";

/**
 * How long a failed run's record answers the reader whose key it ran with.
 * Within it, that reader is told why (and offered a retry) instead of the
 * next poll starting the same run again; past it, the next open of the
 * decision simply runs anew.
 */
export const ANALYSIS_FAILURE_HOLD_MS = 15 * 60 * 1000;

/** The key a reader runs the analysis with. */
export type AnalysisReaderKey =
  | {
      source: "organization";
      organizationId: SafeId<"organization">;
      provider: string;
    }
  | { source: "platform" };

const PLATFORM_KEY_TAG = "platform";

/**
 * The key a failure record is filed under: the platform's one tag, or a tag
 * derived from the organization and the decision for an organization's own
 * key.
 */
export const analysisFailureKeyTag = (
  reader: AnalysisReaderKey,
  decisionId: SafeId<"caseLawDecision">,
): string => {
  switch (reader.source) {
    case "organization":
      return sha256Hex(
        `case-law-analysis-failure:${reader.organizationId}:${decisionId}`,
      );
    case "platform":
      return PLATFORM_KEY_TAG;
    default:
      reader satisfies never;
      return panic("Unhandled analysis reader key");
  }
};

/** One reader's failed run, as stored. */
export type AnalysisFailureRecord = {
  code: CaseLawAnalysisFailureCode;
  inputFingerprint: AnalysisInputFingerprint;
  keySource: CaseLawAnalysisKeySource;
  /** The organization's provider; null for the platform's key. */
  provider: string | null;
  recordedAt: Date;
};

export const analysisFailureRecord = ({
  code,
  fingerprint,
  now,
  reader,
}: {
  code: CaseLawAnalysisFailureCode;
  fingerprint: AnalysisInputFingerprint;
  now: Date;
  reader: AnalysisReaderKey;
}): AnalysisFailureRecord => ({
  code,
  inputFingerprint: fingerprint,
  keySource: reader.source,
  provider: reader.source === "organization" ? reader.provider : null,
  recordedAt: now,
});

/**
 * What a plain (non-retry) claim must not take the row over: a failure filed
 * under this reader's key, over the input being claimed, with the key the
 * reader runs with today, recorded after `heldSince`. The row store checks it
 * in the claim statement itself, so a failure filed between a request's read
 * and its claim still stops the claim.
 */
export type FailureClaimGuard = {
  keyTag: string;
  keySource: CaseLawAnalysisKeySource;
  provider: string | null;
  heldSince: Date;
};

export const failureClaimGuard = ({
  decisionId,
  now,
  reader,
}: {
  decisionId: SafeId<"caseLawDecision">;
  now: Date;
  reader: AnalysisReaderKey;
}): FailureClaimGuard => ({
  keyTag: analysisFailureKeyTag(reader, decisionId),
  keySource: reader.source,
  provider: reader.source === "organization" ? reader.provider : null,
  heldSince: new Date(now.getTime() - ANALYSIS_FAILURE_HOLD_MS),
});

/** The guard's verdict over one stored record, for a store held in memory. */
export const failureMatchesGuard = ({
  failure,
  fingerprint,
  guard,
}: {
  failure: AnalysisFailureRecord;
  fingerprint: AnalysisInputFingerprint;
  guard: FailureClaimGuard;
}): boolean =>
  failure.inputFingerprint === fingerprint &&
  failure.keySource === guard.keySource &&
  failure.provider === guard.provider &&
  failure.recordedAt.getTime() > guard.heldSince.getTime();

/**
 * Whether a stored failure still answers its reader for the document as it
 * reads now: over the same input, within its hold, and with the key the
 * reader would run with today. An organization that switched its provider
 * since the failure runs on the new one rather than hearing the old one's
 * failure.
 */
export const failureStillHolds = ({
  failure,
  fingerprint,
  now,
  reader,
}: {
  failure: AnalysisFailureRecord;
  fingerprint: AnalysisInputFingerprint;
  now: Date;
  reader: AnalysisReaderKey;
}): boolean =>
  failure.inputFingerprint === fingerprint &&
  failure.keySource === reader.source &&
  failure.provider ===
    (reader.source === "organization" ? reader.provider : null) &&
  now.getTime() - failure.recordedAt.getTime() < ANALYSIS_FAILURE_HOLD_MS;
