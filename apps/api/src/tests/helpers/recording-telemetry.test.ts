import { afterEach, describe, expect, test } from "bun:test";

import { captureError } from "@/api/lib/analytics/capture";
import { logger } from "@/api/lib/observability/logger";

import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "./recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "./recording-telemetry";

class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";
}

// The recorders are only useful if the real telemetry path runs in front of
// them, so what is pinned here is that path: fingerprinting, context
// merging, repeat throttling, and attribute redaction.
describe("recording telemetry carries the real capture and logger paths", () => {
  let analytics: RecordingAnalytics | null = null;
  let logs: RecordingLogger | null = null;

  afterEach(() => {
    analytics?.restore();
    logs?.restore();
    analytics = null;
    logs = null;
  });

  test("captureError ships a fingerprinted $exception with the caller's context", () => {
    analytics = installRecordingAnalytics();

    captureError(new QuotaExceededError("user 42 exceeded"), {
      source: "usage.meter",
    });

    const [event] = analytics.exceptions();
    expect(event).toBeDefined();
    expect(event?.properties).toMatchObject({
      $exception_type: "QuotaExceededError",
      "error.class": "QuotaExceededError",
      source: "usage.meter",
    });
    // The redaction contract: the message never reaches the sink.
    expect(JSON.stringify(event)).not.toContain("user 42");
  });

  test("identical errors are throttled to one event per window", () => {
    analytics = installRecordingAnalytics();

    // Same construction site, so the structural fingerprint (class + frame)
    // matches; only the message differs, and the message is redacted.
    const quotaExceeded = (message: string) => new QuotaExceededError(message);
    captureError(quotaExceeded("first"), { source: "usage.meter" });
    captureError(quotaExceeded("second"), { source: "usage.meter" });

    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("the logger records sanitized attributes at the emitted severity", () => {
    logs = installRecordingLogger();

    logger.warn("ingestion.retry", { attempt: 2, authorization: "Bearer x" });

    expect(logs.at("WARN")).toEqual([
      {
        severityText: "WARN",
        message: "ingestion.retry",
        attributes: { attempt: 2, "log.attributes_dropped": 1 },
      },
    ]);
    expect(logs.at("ERROR")).toEqual([]);
  });
});
