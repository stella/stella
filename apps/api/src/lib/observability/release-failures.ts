/**
 * Failure counts per release fingerprint, sent as analytics events the
 * post-release check reads (`scripts/release-health.ts`).
 *
 * Exception capture is throttled per identity, so a feature that fails on
 * every call still reaches the tracker about once a minute. This aggregate
 * counts every observation of a counted grade before any suppression and ends
 * each failure observation window (`failure-shadow.ts`) in one event per
 * fingerprint, so a release's count is its failure count. The analytics
 * client stamps every event with the build's release.
 *
 * A stopping process loses its open window; the check's threshold absorbs
 * one window per process.
 */

import { panic } from "better-result";

import type { FailureGrade, FailureReason } from "@stll/errors";

import { getServerAnalytics } from "@/api/lib/analytics/client";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import type { FailureGrading } from "@/api/lib/observability/failure";
import { identityFields } from "@/api/lib/observability/failure";
import type { FailureEvidence } from "@/api/lib/observability/failure-evidence";
import type { ReleaseFailureEventProperties } from "@/api/lib/observability/release-failure-contract";
import { NO_ERROR_VALUE } from "@/api/lib/observability/release-failure-contract";

type ReleaseFailureDisposition = "counted" | "excluded";

// A client failure follows what callers send, and an anticipated one is a
// designed outcome: neither says a release broke something.
const RELEASE_FAILURE_GRADE_DISPOSITION = {
  defect: "counted",
  transient: "counted",
  anticipated: "excluded",
  client: "excluded",
} as const satisfies Record<FailureGrade, ReleaseFailureDisposition>;

const MAX_RELEASE_FAILURE_KEYS = 200;
const SERVER_DISTINCT_ID = "server";

export type ReleaseFailureIdentity = {
  readonly errorClass: string;
  readonly errorCode: string;
};

/** Class and stable code from the same identity exception grouping uses. */
export const releaseFailureIdentity = (
  evidence: FailureEvidence,
): ReleaseFailureIdentity => {
  const identity = identityFields(evidence);
  return {
    errorClass:
      identity["error.class"] ??
      panic("A failure identity always names a class"),
    errorCode: identity["error.code"] ?? NO_ERROR_VALUE,
  };
};

/** A 5xx answered with no failure observed: there is no error to name. */
export const NO_ERROR_IDENTITY: ReleaseFailureIdentity = {
  errorClass: NO_ERROR_VALUE,
  errorCode: NO_ERROR_VALUE,
};

type ReleaseFailureObservation = {
  /** A route template or a sink label: closed sets, never a request path. */
  readonly handler: string;
  readonly identity: ReleaseFailureIdentity;
  readonly grading: FailureGrading;
};

type ReleaseFailureEntry = {
  readonly handler: string;
  readonly errorClass: string;
  readonly errorCode: string;
  readonly reason: FailureReason;
  occurrences: number;
};

const entries = new Map<string, ReleaseFailureEntry>();
let overflowOccurrences = 0;

export const countReleaseFailure = ({
  handler,
  identity: { errorClass, errorCode },
  grading: { grade, reason },
}: ReleaseFailureObservation): void => {
  switch (RELEASE_FAILURE_GRADE_DISPOSITION[grade]) {
    case "excluded":
      return;
    case "counted":
      break;
    default: {
      RELEASE_FAILURE_GRADE_DISPOSITION[grade] satisfies never;
      return panic("Unhandled release failure disposition");
    }
  }
  const key = [handler, errorClass, errorCode, reason].join("|");
  const existing = entries.get(key);
  if (existing !== undefined) {
    existing.occurrences += 1;
  } else if (entries.size >= MAX_RELEASE_FAILURE_KEYS) {
    overflowOccurrences += 1;
  } else {
    entries.set(key, {
      handler,
      errorClass,
      errorCode,
      reason,
      occurrences: 1,
    });
  }
};

const eventProperties = (
  entry: ReleaseFailureEntry,
): ReleaseFailureEventProperties => ({
  kind: "fingerprint",
  handler: entry.handler,
  error_class: entry.errorClass,
  error_code: entry.errorCode,
  failure_reason: entry.reason,
  occurrences: entry.occurrences,
});

/** Send one event per counted fingerprint and start a new window. */
export const flushReleaseFailures = (): void => {
  const flushed: ReleaseFailureEventProperties[] = [...entries.values()].map(
    eventProperties,
  );
  if (overflowOccurrences > 0) {
    flushed.push({ kind: "overflow", occurrences: overflowOccurrences });
  }
  entries.clear();
  overflowOccurrences = 0;
  const analytics = getServerAnalytics();
  for (const properties of flushed) {
    analytics.capture({
      distinctId: SERVER_DISTINCT_ID,
      event: SERVER_ANALYTICS_EVENTS.releaseFailureWindow,
      properties,
    });
  }
};

/** Drop the window without sending it. Tests only. */
export const resetReleaseFailuresForTesting = (): void => {
  entries.clear();
  overflowOccurrences = 0;
};
