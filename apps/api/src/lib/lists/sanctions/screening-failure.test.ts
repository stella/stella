import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import * as v from "valibot";

import type { FailureGrade } from "@stll/errors";
import { FAILURE_REASON_GRADE } from "@stll/errors";
import { DEFAULT_CUTOFF } from "@stll/sanctions";

import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import { createSanctionsMatcherPool } from "./matcher-pool";
import {
  reportSanctionsScreeningFailure,
  reportSanctionsScreeningWork,
  SANCTIONS_WORK_PRESSURE,
  SanctionsScreeningFailure,
} from "./screening-failure";
import type { SanctionsScreeningFailureCause } from "./screening-failure";

test("real worker startup failure has WARN diagnostics without capture or module details", async () => {
  const logs = installRecordingLogger();
  const analytics = installRecordingAnalytics();
  const metrics: string[] = [];
  const sentinel = "UNAVAILABLE-MODULE-SENTINEL";
  setMetricLineSinkForTesting((line) => {
    metrics.push(line);
  });
  const pool = createSanctionsMatcherPool({
    deadlineMs: 10_000,
    createWorker: () => new Worker(new URL(`${sentinel}.ts`, import.meta.url)),
  });
  try {
    const outcome = await pool.run(
      async (session) =>
        await session.match({
          source: "eu",
          editionId: "startup-probe",
          list: null,
          query: { name: "Česká společnost", entityType: "organisation" },
          cutoff: DEFAULT_CUTOFF,
          limit: 1,
        }),
    );
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") {
      throw new TypeError("Worker startup unexpectedly succeeded");
    }
    expect(["worker-create", "worker-error"]).toContain(outcome.cause);
    expect(logs.records).toHaveLength(1);
    expect(logs.records.at(0)).toMatchObject({
      severityText: "WARN",
      message: "sanctions.matcher_failed",
      attributes: { stage: "matcher-pool", phase: outcome.cause },
    });
    expect(metrics).toHaveLength(0);
    expect(analytics.exceptions()).toHaveLength(0);
    expect(
      JSON.stringify({
        logs: logs.records,
        metrics,
        analytics: analytics.events,
      }),
    ).not.toContain(sentinel);
  } finally {
    await pool.close();
    logs.restore();
    analytics.restore();
    resetMetricLineSinkForTesting();
  }
});

for (const code of ["42501", "ERR_POSTGRES_CONNECTION_CLOSED"] as const) {
  test(`screening failure telemetry preserves safe ${code} evidence without privileged contents`, () => {
    const sentinel = "PRIVILEGED-SCREENING-SENTINEL";
    const logs = installRecordingLogger();
    const analytics = installRecordingAnalytics();
    const metrics: string[] = [];
    setMetricLineSinkForTesting((line) => {
      metrics.push(line);
    });
    try {
      const driver = Object.assign(new Error(sentinel), {
        code,
        query: sentinel,
        detail: sentinel,
        schema: sentinel,
        table: sentinel,
      });
      reportSanctionsScreeningFailure({
        stage: "whole-screening",
        reason: "freshness-read",
        error: new Error(sentinel, {
          cause: new Error(sentinel, { cause: driver }),
        }),
      });
      expect(logs.records).toHaveLength(1);
      expect(logs.records.at(0)).toMatchObject({
        severityText: code === "42501" ? "ERROR" : "WARN",
        message: "sanctions.screening_failed",
        attributes: {
          stage: "whole-screening",
          phase: "freshness-read",
          [code === "42501"
            ? "error.cause.pg_code"
            : "error.cause.pg_driver_code"]: code,
        },
      });
      expect(metrics).toHaveLength(1);
      expect(JSON.parse(metrics.at(0) ?? "null")).toMatchObject({
        sink: "sanctions.screening_failed",
        reason: "unavailable",
        RequestTransientFailures: 1,
      });
      expect(
        JSON.stringify({
          logs: logs.records,
          metrics,
          analytics: analytics.events,
        }),
      ).not.toContain(sentinel);
    } finally {
      logs.restore();
      analytics.restore();
      resetMetricLineSinkForTesting();
    }
  });
}

const screeningGrades = {
  closed: { reason: "closed", grade: "anticipated" },
  admission: { reason: "admission", grade: "anticipated" },
  deadline: { reason: "deadline", grade: "anticipated" },
  "work-limit": { reason: "work-limit", grade: "anticipated" },
  "worker-create": { reason: "worker-create", grade: "defect" },
  "worker-error": { reason: "worker-error", grade: "defect" },
  "worker-exit": { reason: "worker-exit", grade: "defect" },
  "worker-send": { reason: "worker-send", grade: "defect" },
  "worker-reply": { reason: "worker-reply", grade: "defect" },
  "worker-retire": { reason: "worker-retire", grade: "defect" },
  "short-read": { reason: "short-read", grade: "defect" },
  "read-stalled": { reason: "read-stalled", grade: "defect" },
  "matcher-unavailable": { reason: "matcher-unavailable", grade: "defect" },
  "freshness-read": { reason: "freshness-read", grade: "defect" },
  "entries-read": { reason: "entries-read", grade: "defect" },
  operation: { reason: "operation", grade: "defect" },
} as const satisfies {
  [Cause in SanctionsScreeningFailureCause]: {
    reason: Cause;
    grade: FailureGrade;
  };
};

test.each(Object.values(screeningGrades))(
  "$reason has a declared screening grade $grade",
  ({ reason, grade }) => {
    const failure = new SanctionsScreeningFailure({
      message: "Unavailable",
      stage: "whole-screening",
      reason,
    });
    const graded = gradeFailure(
      readEvidence(failure),
      failureSink({ event: "sanctions.screening_failed", expected: [] }),
    );
    expect(graded.grade).toBe(grade);
    expect(graded.rule).toBe("brand");
    expect(FAILURE_REASON_GRADE[graded.reason]).toBe(grade);
  },
);

test("non-PG causes retain infrastructure evidence without exporting contents", () => {
  const logs = installRecordingLogger();
  const analytics = installRecordingAnalytics();
  const sentinel = "NON-PG-PRIVATE-SENTINEL";
  const cause = Object.assign(new Error(sentinel), { code: "ECONNRESET" });
  try {
    reportSanctionsScreeningFailure({
      stage: "whole-screening",
      reason: "operation",
      error: cause,
    });
    expect(logs.records.at(0)).toMatchObject({
      severityText: "WARN",
      attributes: {
        "failure.grade": "transient",
        "failure.reason": "network_reset",
      },
    });
    expect(analytics.exceptions()).toHaveLength(0);
    expect(JSON.stringify(logs.records)).not.toContain(sentinel);
  } finally {
    logs.restore();
    analytics.restore();
  }
});

test("a successful null lease has no diagnostic or capture", async () => {
  const logs = installRecordingLogger();
  const analytics = installRecordingAnalytics();
  const pool = createSanctionsMatcherPool();
  try {
    expect(await pool.run(async () => null)).toEqual({
      status: "completed",
      value: null,
    });
    await pool.close();
    expect(logs.records).toHaveLength(0);
    expect(analytics.exceptions()).toHaveLength(0);
  } finally {
    await pool.close();
    logs.restore();
    analytics.restore();
  }
});

test("every completed screening reports its budget share and warns above the pressure line", () => {
  const logs = installRecordingLogger();
  const metrics: string[] = [];
  setMetricLineSinkForTesting((line) => {
    metrics.push(line);
  });
  try {
    const limit = 2_000_000;
    reportSanctionsScreeningWork({ source: "eu", spent: limit / 2, limit });
    expect(logs.records).toHaveLength(0);
    reportSanctionsScreeningWork({
      source: "uk",
      spent: Math.ceil(limit * SANCTIONS_WORK_PRESSURE) + 1,
      limit,
    });
    expect(logs.at("WARN")).toHaveLength(1);
    expect(logs.records.at(0)).toMatchObject({
      severityText: "WARN",
      message: "sanctions.screening_work_pressure",
      attributes: { source: "uk", limit },
    });
    const workUsageLine = v.object({
      source: v.string(),
      SanctionsScreeningWorkUsage: v.number(),
    });
    const parsed = metrics.map((line) =>
      v.parse(workUsageLine, JSON.parse(line)),
    );
    expect(
      parsed.map((line) => [line.source, line.SanctionsScreeningWorkUsage]),
    ).toEqual([
      ["eu", 50],
      ["uk", ((Math.ceil(limit * SANCTIONS_WORK_PRESSURE) + 1) / limit) * 100],
    ]);
  } finally {
    logs.restore();
    resetMetricLineSinkForTesting();
  }
});
