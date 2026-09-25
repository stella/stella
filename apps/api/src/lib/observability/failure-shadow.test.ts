import { UnhandledException } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  countFailureObservation,
  flushFailureObservations,
  legacyChannelOf,
  reportEmitFailure,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const grading = gradeFailure(
  readEvidence(Object.assign(new Error("x"), { code: "ECONNRESET" })),
  failureSink({ event: "bounds", expected: [] }),
);

describe("the shadow aggregate", () => {
  let logs: RecordingLogger;

  beforeEach(() => {
    logs = installRecordingLogger();
    resetFailureObservationsForTesting();
  });

  afterEach(() => {
    logs.restore();
    resetFailureObservationsForTesting();
  });

  test("keeps at most 200 keys a window and counts the rest as overflow", () => {
    for (let index = 0; index < 250; index++) {
      const sink = failureSink({ event: `sink.${index}`, expected: [] });
      countFailureObservation({
        sink,
        grading,
        channel: "capture",
        degradation: undefined,
      });
      countFailureObservation({
        sink,
        grading,
        channel: "capture",
        degradation: undefined,
      });
    }

    flushFailureObservations();

    const observed = logs.records.filter(
      ({ message }) => message === "failure.observed",
    );
    expect(observed).toHaveLength(200);
    expect(
      observed.every(({ attributes }) => attributes?.["occurrences"] === 2),
    ).toBe(true);
    expect(
      logs.records
        .filter(({ message }) => message === "failure.observed_overflow")
        .map(({ attributes }) => attributes),
    ).toEqual([{ occurrences: 100 }]);
    expect(
      logs.records.every(({ severityText }) => severityText === "INFO"),
    ).toBe(true);
  });

  test("keys on sink, grade, reason, channel and degradation", () => {
    const sink = failureSink({ event: "keyed", expected: [] });
    for (const channel of ["capture", "log_warn", "capture"] as const) {
      countFailureObservation({
        sink,
        grading,
        channel,
        degradation: undefined,
      });
    }
    countFailureObservation({
      sink,
      grading,
      channel: "capture",
      degradation: "frame_absent",
    });

    flushFailureObservations();

    expect(
      logs.records.map(({ attributes }) => [
        attributes?.["failure.legacy_channel"],
        attributes?.["error.fingerprint_degraded"],
        attributes?.["occurrences"],
      ]),
    ).toEqual([
      ["capture", "none", 2],
      ["log_warn", "none", 1],
      ["capture", "frame_absent", 1],
    ]);
  });

  test("the scheduled flush reports a logger failure instead of throwing", () => {
    const sink = failureSink({ event: "scheduled", expected: [] });
    const scheduled: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = Object.assign(
      (callback: () => void) => {
        scheduled.push(callback);
        return realSetTimeout(() => undefined, 0);
      },
      { __promisify__: realSetTimeout.__promisify__ },
    );
    try {
      countFailureObservation({
        sink,
        grading,
        channel: "capture",
        degradation: undefined,
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    const reported: string[] = [];
    setLogSinkForTesting((record) => {
      if (record.message === "failure.observed") {
        throw new TypeError("log sink down");
      }
      reported.push(String(record.attributes?.["observability.stage"]));
    });

    // A throw here would fail the test: the callback is what the timer runs.
    scheduled.at(0)?.();

    expect(scheduled).toHaveLength(1);
    expect(reported).toEqual(["flush"]);
  });

  test("a flush starts a new window", () => {
    const sink = failureSink({ event: "windowed", expected: [] });
    countFailureObservation({
      sink,
      grading,
      channel: "capture",
      degradation: undefined,
    });
    flushFailureObservations();
    flushFailureObservations();

    expect(logs.records).toHaveLength(1);
  });

  test("names every legacy channel from the emitting call", () => {
    expect([
      legacyChannelOf({ severity: undefined, capture: true }),
      legacyChannelOf({ severity: "WARN", capture: false }),
      legacyChannelOf({ severity: "WARN", capture: true }),
      legacyChannelOf({ severity: "ERROR", capture: false }),
      legacyChannelOf({ severity: "ERROR", capture: true }),
    ]).toEqual([
      "capture",
      "log_warn",
      "log_warn_and_capture",
      "log_error",
      "log_error_and_capture",
    ]);
  });
});

describe("emitter failure isolation", () => {
  afterEach(() => {
    resetLogSinkForTesting();
  });

  test("reports through the plain logger", () => {
    const logs = installRecordingLogger();
    try {
      reportEmitFailure("capture", new TypeError("tracker down"));

      expect(logs.records).toEqual([
        {
          severityText: "WARN",
          message: "observability.emit_failed",
          attributes: {
            "observability.stage": "capture",
            "error.type": "TypeError",
            "observability.unowned": true,
          },
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("names the thrown value, not the wrapper it was caught in", () => {
    const logs = installRecordingLogger();
    try {
      reportEmitFailure(
        "observe",
        new UnhandledException({ cause: new RangeError("grading failed") }),
      );

      expect(logs.records.at(0)?.attributes?.["error.type"]).toBe("RangeError");
    } finally {
      logs.restore();
    }
  });

  test("a failing logger neither throws nor re-enters", () => {
    let attempts = 0;
    setLogSinkForTesting(() => {
      attempts += 1;
      reportEmitFailure("observe", new TypeError("nested"));
      throw new TypeError("log sink down");
    });

    // Returning at all is the first half: a throw here fails the test.
    reportEmitFailure("observe", new TypeError("first"));

    expect(attempts).toBe(1);
  });
});
