/**
 * Shadow grading: the owner's grade, attached to the failure records the
 * existing sinks already emit, without changing what they emit or at which
 * severity.
 *
 * Every site that observes a failure today decided its own channel (capture,
 * a WARN, an ERROR, or both). Before any of those decisions moves to the
 * owner's policy, the grade it would have chosen rides along on the record,
 * and one bounded INFO aggregate counts, per sink, how often each grade met
 * each legacy channel. That count is taken before capture suppression, so it
 * is the failure rate rather than the admitted rate.
 *
 * Removal condition: the aggregate is deleted once no sink carries a legacy
 * output pin.
 */

import { panic, Result, UnhandledException } from "better-result";

import { failureGradeOf } from "@stll/errors";

import { errorTag } from "@/api/lib/errors/error-tag";
import type {
  FailureGrading,
  FailureRequestState,
  FailureSink,
  FingerprintDegradation,
} from "@/api/lib/observability/failure";
import {
  failureSink,
  fingerprintDegradation,
  gradeFailure,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { logger } from "@/api/lib/observability/logger";
import { recordRequestFailure } from "@/api/lib/observability/request-context";
import { emitFailureMetric } from "@/api/lib/observability/request-metrics";

/** The channel the emitting call actually used, not one inferred from nearby source. */
const LEGACY_CHANNELS = [
  "capture",
  "log_warn",
  "log_error",
  "log_warn_and_capture",
  "log_error_and_capture",
] as const;

type LegacyChannel = (typeof LEGACY_CHANNELS)[number];

export const legacyChannelOf = ({
  severity,
  capture,
}: {
  severity: "ERROR" | "WARN" | undefined;
  capture: boolean;
}): LegacyChannel => {
  switch (severity) {
    case undefined:
      return "capture";
    case "WARN":
      return capture ? "log_warn_and_capture" : "log_warn";
    case "ERROR":
      return capture ? "log_error_and_capture" : "log_error";
    default: {
      severity satisfies never;
      return panic(`Unhandled severity: ${String(severity)}`);
    }
  }
};

/** The sinks graded in shadow, one handle per existing emission site. */
export const SHADOW_SINKS = {
  capture: failureSink({ event: "exception.captured", expected: [] }),
  handler: failureSink({ event: "request.handler_failed", expected: [] }),
  framework: failureSink({ event: "request.framework_failed", expected: [] }),
  completion: failureSink({ event: "request.completed", expected: [] }),
} as const satisfies Record<string, FailureSink>;

// --- Emitter failure isolation ------------------------------------------------

type EmitStage = "capture" | "flush" | "observe" | "shadow";

let reportingEmitFailure = false;

/**
 * Report that telemetry itself failed, through the plain logger only: this
 * path never captures, and a failure while reporting is dropped rather than
 * re-entered, so an observability fault can neither replace the original
 * answer nor feed back into itself.
 */
export const reportEmitFailure = (stage: EmitStage, error: unknown): void => {
  if (reportingEmitFailure) {
    return;
  }
  reportingEmitFailure = true;
  // The callers catch through `Result.try`, which wraps what was thrown; the
  // thrown value is what names the fault.
  const thrown = UnhandledException.is(error) ? error.cause : error;
  // A failure here has nothing left to report through, so it is dropped.
  Result.try(() => {
    logger.warn("observability.emit_failed", {
      "observability.stage": stage,
      "error.type": errorTag(thrown),
    });
  }).unwrapOr(undefined);
  reportingEmitFailure = false;
};

// --- Aggregate ----------------------------------------------------------------

const AGGREGATE_WINDOW_MS = 60_000;
const MAX_AGGREGATE_KEYS = 200;

type AggregateEntry = {
  readonly sink: string;
  readonly grade: string;
  readonly reason: string;
  readonly channel: LegacyChannel;
  readonly degradation: FingerprintDegradation | "none";
  occurrences: number;
};

const aggregate = new Map<string, AggregateEntry>();
let overflowOccurrences = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Emit one INFO line per aggregated key and start a new window. The timer
 * calls this at the end of each window; tests call it directly.
 */
export const flushFailureObservations = (): void => {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const entries = [...aggregate.values()];
  const overflow = overflowOccurrences;
  aggregate.clear();
  overflowOccurrences = 0;
  for (const entry of entries) {
    logger.info("failure.observed", {
      "failure.sink": entry.sink,
      "failure.grade": entry.grade,
      "failure.reason": entry.reason,
      "failure.legacy_channel": entry.channel,
      "error.fingerprint_degraded": entry.degradation,
      occurrences: entry.occurrences,
    });
  }
  if (overflow > 0) {
    logger.info("failure.observed_overflow", { occurrences: overflow });
  }
};

// A throw inside a timer callback is an uncaught exception, so the scheduled
// flush reports a failure instead of letting it escape.
const flushOnTimer = (): void => {
  const flushed = Result.try(flushFailureObservations);
  if (Result.isError(flushed)) {
    reportEmitFailure("flush", flushed.error);
  }
};

type FailureObservationCount = {
  readonly sink: FailureSink;
  readonly grading: FailureGrading;
  readonly channel: LegacyChannel;
  readonly degradation: FingerprintDegradation | undefined;
};

export const countFailureObservation = ({
  sink,
  grading,
  channel,
  degradation,
}: FailureObservationCount): void => {
  const entry = {
    sink: sink.event,
    grade: grading.grade,
    reason: grading.reason,
    channel,
    degradation: degradation ?? "none",
  } as const;
  const key = [
    entry.sink,
    entry.grade,
    entry.reason,
    entry.channel,
    entry.degradation,
  ].join("|");
  const existing = aggregate.get(key);
  if (existing !== undefined) {
    existing.occurrences += 1;
  } else if (aggregate.size >= MAX_AGGREGATE_KEYS) {
    overflowOccurrences += 1;
  } else {
    aggregate.set(key, { ...entry, occurrences: 1 });
  }
  if (flushTimer === undefined) {
    flushTimer = setTimeout(flushOnTimer, AGGREGATE_WINDOW_MS);
    flushTimer.unref();
  }
};

/** Drop the window without emitting it. Tests only. */
export const resetFailureObservationsForTesting = (): void => {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  aggregate.clear();
  overflowOccurrences = 0;
};

// --- Shadow observation -------------------------------------------------------

type ShadowObservation = {
  readonly error: unknown;
  readonly sink: FailureSink;
  readonly channel: LegacyChannel;
  readonly request?: Request | undefined;
  readonly requestState?: FailureRequestState | undefined;
};

const recordRequestObservation = (
  request: Request,
  sink: FailureSink,
  grading: FailureGrading,
): void => {
  recordRequestFailure(request, {
    grade: grading.grade,
    reason: grading.reason,
    sink: sink.event,
  });
  if (grading.grade === "transient") {
    emitFailureMetric({ sink: sink.event, reason: grading.reason });
  }
};

/**
 * Grade a failure an existing sink is about to emit, count it, and hand the
 * grade back for the sink's own record. A request-path observation is also
 * stored on the request, for the completion record, and a transient one is
 * counted in the failure metric. Returns undefined, and emits nothing extra,
 * if grading itself failed.
 */
export const observeShadow = ({
  error,
  sink,
  channel,
  request,
  requestState,
}: ShadowObservation): FailureGrading | undefined => {
  const observed = Result.try(() => {
    const evidence = readEvidence(error);
    const grading = gradeFailure(evidence, sink, {
      ...requestState,
      requestAborted: request?.signal.aborted,
    });
    countFailureObservation({
      sink,
      grading,
      channel,
      degradation: fingerprintDegradation(evidence),
    });
    if (request !== undefined) {
      recordRequestObservation(request, sink, grading);
    }
    return grading;
  });
  if (Result.isError(observed)) {
    reportEmitFailure("shadow", observed.error);
    return undefined;
  }
  return observed.value;
};

// A 5xx the request answered with no failure observed on the way there.
const UNOBSERVED_5XX_GRADING: FailureGrading = {
  grade: failureGradeOf("unobserved_5xx"),
  reason: "unobserved_5xx",
  rule: "unobserved",
  evidenceDepth: 0,
};

/** Count a 5xx no failure observation accounts for, and grade it. */
export const observeUnobserved5xx = (): FailureGrading => {
  countFailureObservation({
    sink: SHADOW_SINKS.completion,
    grading: UNOBSERVED_5XX_GRADING,
    channel: "log_error",
    degradation: undefined,
  });
  return UNOBSERVED_5XX_GRADING;
};

/** The fields a shadow-graded record carries. */
export const shadowFields = (
  grading: FailureGrading | undefined,
): Record<string, string> =>
  grading === undefined
    ? {}
    : {
        "failure.grade": grading.grade,
        "failure.reason": grading.reason,
        "failure.shadow": "true",
      };
