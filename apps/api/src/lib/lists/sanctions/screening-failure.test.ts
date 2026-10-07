import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import { DEFAULT_CUTOFF } from "@stll/sanctions";

import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import { createSanctionsMatcherPool } from "./matcher-pool";
import { reportSanctionsScreeningFailure } from "./screening-failure";

test("real worker startup failure reaches the bound logger and metric without module details", async () => {
  const logs = installRecordingLogger();
  const analytics = installRecordingAnalytics();
  const metrics: string[] = [];
  const sentinel = "UNAVAILABLE-MODULE-SENTINEL";
  setMetricLineSinkForTesting((line) => metrics.push(line));
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
      severityText: "ERROR",
      message: "sanctions.screening_failed",
      attributes: { stage: "matcher-pool", phase: outcome.cause },
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
    setMetricLineSinkForTesting((line) => metrics.push(line));
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
