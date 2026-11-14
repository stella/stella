import { afterEach, beforeEach, expect, test } from "bun:test";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { observeLimiterAdmissionFailure } from "@/api/lib/observability/limiter-admission-failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  getRequestFailure,
  runWithRequestId,
} from "@/api/lib/observability/request-context";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { LimiterStoreUnavailableError } from "@/api/lib/rate-limit/store-unavailable";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

let analytics: RecordingAnalytics;
let logs: RecordingLogger;
let metrics: string[];

beforeEach(() => {
  analytics = installRecordingAnalytics();
  logs = installRecordingLogger();
  metrics = [];
  setMetricLineSinkForTesting((line) => {
    metrics.push(line);
  });
});

afterEach(() => {
  analytics.restore();
  logs.restore();
  resetMetricLineSinkForTesting();
});

const sink = failureSink({ event: "limiter.contract", expected: [] });
const admissionStoreFailure = () =>
  new ActionAdmissionError({
    reason: "store_unavailable",
    message: "Coordination unavailable",
    cause: Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    }),
  });

test("a request records a store failure once across admission and HTTP boundaries", () => {
  for (const requestId of ["req_limiter_first", "req_limiter_second"]) {
    runWithRequestId(requestId, () => {
      observeLimiterAdmissionFailure(admissionStoreFailure(), "mcp");
      observeFailure(
        new LimiterStoreUnavailableError({
          message: "Coordination unavailable",
          operation: "increment",
        }),
        { sink },
      );
      expect(getRequestFailure()).toMatchObject({
        grade: "transient",
        reason: "limiter_store_unavailable",
      });
    });
  }
  expect(logs.records).toHaveLength(2);
  expect(metrics).toHaveLength(2);
  expect(analytics.exceptions()).toHaveLength(0);
  for (const record of logs.records) {
    expect(record.severityText).toBe("WARN");
    expect(record.attributes).toMatchObject({
      operation: "mcp",
      "failure.reason": "limiter_store_unavailable",
      "failure.grade": "transient",
    });
    expect(record.attributes).not.toHaveProperty("organizationId");
    expect(record.attributes).not.toHaveProperty("userId");
  }
});

test.each([
  {
    reason: "configuration_incomplete",
    grade: "defect",
    failureReason: "admission_configuration_incomplete",
  },
  {
    reason: "organization_state_unreadable",
    grade: "transient",
    failureReason: "organization_state_unreadable",
  },
  {
    reason: "lease_lost",
    grade: "transient",
    failureReason: "admission_lease_lost",
  },
] as const)(
  "$reason preserves its own failure classification",
  ({ reason, grade, failureReason }) => {
    const error = new ActionAdmissionError({
      reason,
      message: "Admission unavailable",
    });
    expect(gradeFailure(readEvidence(error), sink)).toMatchObject({
      grade,
      reason: failureReason,
    });
    observeLimiterAdmissionFailure(error, "admission");
    expect(logs.records).toHaveLength(1);
    expect(analytics.exceptions()).toHaveLength(grade === "defect" ? 1 : 0);
  },
);

test("a store error retains its transient classification with connection refusal evidence", () => {
  const error = new LimiterStoreUnavailableError({
    message: "Coordination unavailable",
    operation: "connect",
    cause: Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    }),
  });
  expect(gradeFailure(readEvidence(error), sink)).toMatchObject({
    grade: "transient",
    reason: "limiter_store_unavailable",
  });
});

test("a counted refusal is not observed as an admission infrastructure failure", () => {
  observeLimiterAdmissionFailure(
    new ActionAdmissionError({
      reason: "period_exhausted",
      retryAtMs: 1000,
      message: "Period exhausted",
    }),
    "admission",
  );
  expect(logs.records).toHaveLength(0);
  expect(metrics).toHaveLength(0);
  expect(analytics.exceptions()).toHaveLength(0);
});
