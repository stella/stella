import { resetCaptureWindows } from "@/api/lib/analytics/capture";
import {
  resetAnalyticsForTesting,
  setAnalyticsForTesting,
} from "@/api/lib/analytics/client";
import type {
  OrganizationGroupIdentifyParams,
  ServerAnalyticsCaptureParams,
} from "@/api/lib/analytics/types";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import type { LogRecord } from "@/api/lib/observability/logger";

// Recording sinks for the two telemetry boundaries. The real `captureError`,
// `createTanStackAIAnalyticsCallbacks`, and `logger` run unchanged (error
// fingerprinting, attribute redaction, repeat throttling); only the final
// hop into PostHog or the OTel pipeline is replaced. Prefer these over
// `mock.module("@/api/lib/analytics/capture")` or the logger: a test then
// asserts on the event that would have shipped, not on a call to a function
// the real module may no longer export with that shape.

export type ExceptionEvent = Extract<
  ServerAnalyticsCaptureParams,
  { event: typeof SERVER_ANALYTICS_EVENTS.exception }
>;

export type RecordingAnalytics = {
  readonly events: ServerAnalyticsCaptureParams[];
  readonly groupIdentifies: OrganizationGroupIdentifyParams[];
  /** Captured `$exception` events, in order. */
  readonly exceptions: () => ExceptionEvent[];
  /** Restore the real client. Call from the matching after-hook. */
  readonly restore: () => void;
};

const isException = (
  params: ServerAnalyticsCaptureParams,
): params is ExceptionEvent =>
  params.event === SERVER_ANALYTICS_EVENTS.exception;

/**
 * Route analytics into an in-memory list. Also clears the capture throttle,
 * because identical errors are reported once per window and module state
 * would otherwise leak one test's suppression into the next.
 */
export const installRecordingAnalytics = (): RecordingAnalytics => {
  const events: ServerAnalyticsCaptureParams[] = [];
  const groupIdentifies: OrganizationGroupIdentifyParams[] = [];
  resetCaptureWindows();
  setAnalyticsForTesting({
    capture: (params) => {
      events.push(params);
    },
    identifyOrganizationGroup: (params) => {
      groupIdentifies.push(params);
    },
    flush: async () => await Promise.resolve(),
  });
  return {
    events,
    groupIdentifies,
    exceptions: () => events.filter(isException),
    restore: () => {
      resetAnalyticsForTesting();
      resetCaptureWindows();
    },
  };
};

export type RecordingLogger = {
  readonly records: LogRecord[];
  /** Records at one severity (`"ERROR"`, `"WARN"`, ...), in order. */
  readonly at: (severityText: string) => LogRecord[];
  readonly restore: () => void;
};

/** Route every sanitized log record into an in-memory list. */
export const installRecordingLogger = (): RecordingLogger => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  return {
    records,
    at: (severityText) =>
      records.filter((record) => record.severityText === severityText),
    restore: resetLogSinkForTesting,
  };
};
