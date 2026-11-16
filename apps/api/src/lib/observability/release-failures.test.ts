import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { FailureGrading } from "@/api/lib/observability/failure";
import { failureSink } from "@/api/lib/observability/failure";
import {
  flushFailureObservations,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { RELEASE_FAILURE_EVENT } from "@/api/lib/observability/release-failure-contract";
import {
  countReleaseFailure,
  flushReleaseFailures,
} from "@/api/lib/observability/release-failures";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const IDENTITY = { errorClass: "HandlerError", errorCode: "HandlerError" };

const grading = (
  grade: FailureGrading["grade"],
  reason: FailureGrading["reason"],
): FailureGrading => ({
  grade,
  reason,
  rule: "unclassified",
  evidenceDepth: 0,
});

describe("release failure counts", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    resetFailureObservationsForTesting();
  });

  afterEach(() => {
    resetFailureObservationsForTesting();
    logs.restore();
    analytics.restore();
  });

  const releaseEvents = () =>
    analytics.events
      .filter(({ event }) => event === RELEASE_FAILURE_EVENT)
      .map(({ properties }) => properties);

  test("one event per fingerprint and reason carries the window's count", () => {
    for (let index = 0; index < 3; index++) {
      countReleaseFailure({
        handler: "/v1/summaries",
        identity: IDENTITY,
        grading: grading("defect", "unclassified"),
      });
    }
    countReleaseFailure({
      handler: "/v1/summaries",
      identity: IDENTITY,
      grading: grading("transient", "upstream_unavailable"),
    });

    flushReleaseFailures();

    expect(releaseEvents()).toEqual([
      {
        kind: "fingerprint",
        handler: "/v1/summaries",
        error_class: "HandlerError",
        error_code: "HandlerError",
        failure_reason: "unclassified",
        occurrences: 3,
      },
      {
        kind: "fingerprint",
        handler: "/v1/summaries",
        error_class: "HandlerError",
        error_code: "HandlerError",
        failure_reason: "upstream_unavailable",
        occurrences: 1,
      },
    ]);
  });

  test("client and anticipated failures say nothing about a release", () => {
    countReleaseFailure({
      handler: "/v1/files",
      identity: IDENTITY,
      grading: grading("client", "not_found"),
    });
    countReleaseFailure({
      handler: "/v1/chat",
      identity: IDENTITY,
      grading: grading("anticipated", "generation_cancelled"),
    });

    flushReleaseFailures();

    expect(releaseEvents()).toEqual([]);
  });

  test("keeps at most 200 fingerprints a window and counts the rest", () => {
    for (let index = 0; index < 205; index++) {
      countReleaseFailure({
        handler: `/v1/route-${index}`,
        identity: IDENTITY,
        grading: grading("defect", "unclassified"),
      });
    }

    flushReleaseFailures();
    flushReleaseFailures();

    const events = releaseEvents();
    expect(events).toHaveLength(201);
    expect(events.at(-1)).toEqual({ kind: "overflow", occurrences: 5 });
  });

  test("every observed failure is counted under its sink, class and code", () => {
    const sink = failureSink({ event: "summaries.generate", expected: [] });

    observeFailure(
      new HandlerError({ status: 500, message: "summary failed" }),
      { sink },
    );
    flushFailureObservations();

    expect(releaseEvents()).toEqual([
      {
        kind: "fingerprint",
        handler: "summaries.generate",
        error_class: "HandlerError",
        error_code: "HandlerError",
        failure_reason: "tagged_failure",
        occurrences: 1,
      },
    ]);
  });
});
