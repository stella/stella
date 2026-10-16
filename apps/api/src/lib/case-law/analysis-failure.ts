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
import type { RedactedProviderDiagnostic } from "@/api/lib/errors/redacted-provider-diagnostic";

/**
 * How long a failed run's record answers the reader whose key it ran with.
 * Within it, that reader is told why (and offered a retry) instead of the
 * next poll starting the same run again; past it, the next open of the
 * decision simply runs anew. A provider that named a later retry time holds
 * the record until then instead (`retryAfter`).
 */
export const ANALYSIS_FAILURE_HOLD_MS = 15 * 60 * 1000;

/**
 * What a request asks of the analysis: a plain read, which a recent failure
 * answers, or the reader's explicit request to run again, which only a
 * provider's pending retry time refuses.
 */
export type AnalysisRequestKind = "poll" | "retry";

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
  /**
   * The time the provider asked not to be called again before, when the
   * failing answer named a delay. Until then neither a poll nor an explicit
   * retry runs again.
   */
  retryAfter?: Date | undefined;
  providerDiagnostic?: RedactedProviderDiagnostic | undefined;
};

export const analysisFailureRecord = ({
  code,
  fingerprint,
  now,
  reader,
  providerDiagnostic,
  retryAfterMs,
}: {
  code: CaseLawAnalysisFailureCode;
  fingerprint: AnalysisInputFingerprint;
  now: Date;
  reader: AnalysisReaderKey;
  providerDiagnostic?: RedactedProviderDiagnostic | undefined;
  /** The provider's stated retry delay, when it named one. */
  retryAfterMs?: number | undefined;
}): AnalysisFailureRecord => ({
  code,
  inputFingerprint: fingerprint,
  keySource: reader.source,
  provider: reader.source === "organization" ? reader.provider : null,
  recordedAt: now,
  // The delay is the final answer's, so it is still ahead whatever its size:
  // a short one the call already waited out ended in an answer, not here.
  ...(retryAfterMs === undefined || retryAfterMs <= 0
    ? {}
    : { retryAfter: new Date(now.getTime() + retryAfterMs) }),
  ...(providerDiagnostic === undefined ? {} : { providerDiagnostic }),
});

/** Whether a failure's provider retry time is still ahead of `now`. */
export const failureRetryPending = (
  failure: Pick<AnalysisFailureRecord, "retryAfter">,
  now: Date,
): boolean =>
  failure.retryAfter !== undefined &&
  failure.retryAfter.getTime() > now.getTime();

/** Which reader key a failure must have been filed with to apply. */
type FailureKeyMatch = {
  keySource: CaseLawAnalysisKeySource;
  provider: string | null;
};

/** When a failure holds: the request's time, and the plain hold's start. */
type FailureHoldWindow = {
  now: Date;
  /** Null for an explicit retry, which only a provider's retry time refuses. */
  heldSince: Date | null;
};

/**
 * What a claim must not take the row over: a failure filed under this
 * reader's key, over the input being claimed, with the key the reader runs
 * with today, whose provider retry time is after `now` or (for a plain poll)
 * which was recorded after `heldSince`. The row store checks it in the claim
 * transaction itself, so a failure filed between a request's read and its
 * claim still stops the claim.
 */
export type FailureClaimGuard = FailureKeyMatch &
  FailureHoldWindow & { keyTag: string };

const keyMatchOf = (reader: AnalysisReaderKey): FailureKeyMatch => ({
  keySource: reader.source,
  provider: reader.source === "organization" ? reader.provider : null,
});

const holdWindowOf = (
  request: AnalysisRequestKind,
  now: Date,
): FailureHoldWindow => {
  switch (request) {
    case "poll":
      return {
        now,
        heldSince: new Date(now.getTime() - ANALYSIS_FAILURE_HOLD_MS),
      };
    case "retry":
      return { now, heldSince: null };
    default:
      request satisfies never;
      return panic("Unhandled analysis request kind");
  }
};

export const failureClaimGuard = ({
  decisionId,
  now,
  reader,
  request,
}: {
  decisionId: SafeId<"caseLawDecision">;
  now: Date;
  reader: AnalysisReaderKey;
  request: AnalysisRequestKind;
}): FailureClaimGuard => ({
  keyTag: analysisFailureKeyTag(reader, decisionId),
  ...keyMatchOf(reader),
  ...holdWindowOf(request, now),
});

/** The guard's verdict over one stored record, for a store held in memory. */
export const failureMatchesGuard = ({
  failure,
  fingerprint,
  guard,
}: {
  failure: AnalysisFailureRecord;
  fingerprint: AnalysisInputFingerprint;
  guard: FailureKeyMatch & FailureHoldWindow;
}): boolean =>
  failure.inputFingerprint === fingerprint &&
  failure.keySource === guard.keySource &&
  failure.provider === guard.provider &&
  ((guard.heldSince !== null &&
    failure.recordedAt.getTime() > guard.heldSince.getTime()) ||
    failureRetryPending(failure, guard.now));

/**
 * Whether a stored failure still answers its reader for the document as it
 * reads now: over the same input, with the key the reader would run with
 * today, and within its hold. A plain poll is held until the later of the
 * hold's end and the provider's retry time; an explicit retry only until the
 * provider's retry time. An organization that switched its provider since
 * the failure runs on the new one rather than hearing the old one's failure.
 */
export const failureStillHolds = ({
  failure,
  fingerprint,
  now,
  reader,
  request,
}: {
  failure: AnalysisFailureRecord;
  fingerprint: AnalysisInputFingerprint;
  now: Date;
  reader: AnalysisReaderKey;
  request: AnalysisRequestKind;
}): boolean =>
  failureMatchesGuard({
    failure,
    fingerprint,
    guard: { ...keyMatchOf(reader), ...holdWindowOf(request, now) },
  });
