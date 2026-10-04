import { describe, expect, test } from "bun:test";
import { ValiError } from "valibot";

import { readEuCompletionTickEnvironment } from "@/api/env-eu-completion";
import type { EuCompletionReport } from "@/api/handlers/case-law/ingestion/eu-completion";
import {
  euCompletionMetricRecord,
  euCompletionQueueMetricRecord,
  runEuCompletionTickScript,
} from "@/api/scripts/eu-completion-tick";

const environment = {
  CASE_LAW_EU_COMPLETION_ENABLED: true,
  CASE_LAW_EU_COMPLETION_KILL_SWITCH: false,
  CASE_LAW_EU_COMPLETION_MODE: "dry-run",
  CASE_LAW_EU_COMPLETION_MAX_ROWS: 25,
} as const;
const report = (status: EuCompletionReport["status"]): EuCompletionReport => ({
  status,
  attempted: 1,
  applied: 0,
  unchanged: 0,
  reviewRequired: 0,
  retries: 0,
  failed: 0,
  requests: 1,
  cursorMoved: 1,
  noProgress: 1,
  durationMs: 10,
});

describe("scheduled EU completion", () => {
  test("the disabled executable requires no database or object storage environment", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        new URL("eu-completion-tick.ts", import.meta.url).pathname,
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      env: { PATH: process.env["PATH"], NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      status: "off",
      "case_law.eu_completion.enabled": 0,
      "case_law.eu_completion.requests": 0,
    });
  });

  test("production cannot obtain a fixture runner before runtime initialization", async () => {
    const entry = new URL("eu-completion-tick.ts", import.meta.url).pathname;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--eval",
        `const { getEuCompletionFixtureRunner } = await import(${JSON.stringify(entry)}); getEuCompletionFixtureRunner();`,
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      env: { PATH: process.env["PATH"], NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Completion fixtures require a local test run");
    expect(stderr).not.toContain("DATABASE_URL");
  });

  test("default-off and kill switches prevent all enabled-job setup", async () => {
    const runs: number[] = [];
    const runEnabled = async () => {
      runs.push(1);
      return report("completed");
    };
    for (const controls of [
      { ...environment, CASE_LAW_EU_COMPLETION_ENABLED: false },
      { ...environment, CASE_LAW_EU_COMPLETION_KILL_SWITCH: true },
    ]) {
      const records: unknown[] = [];
      expect(
        await runEuCompletionTickScript({
          environment: controls,
          runEnabled,
          log: (record) => {
            records.push(record);
          },
        }),
      ).toBe(0);
      expect(records).toHaveLength(1);
      expect(records.at(0)).toMatchObject({
        status: "off",
        "case_law.eu_completion.enabled": 0,
      });
    }
    expect(runs).toHaveLength(0);
  });

  test("only a failed tick exits nonzero; failed rows, holds and publisher refusals are normal scheduled stops", async () => {
    const statuses = [
      "completed",
      "off",
      "held",
      "approval-required",
      "time-limit",
      "publisher-refused",
      "request-budget",
      "byte-budget",
      "cancelled",
      "failed",
    ] as const satisfies readonly EuCompletionReport["status"][];
    for (const status of statuses) {
      const records: unknown[] = [];
      expect(
        await runEuCompletionTickScript({
          environment,
          runEnabled: async () => ({ ...report(status), failed: 1 }),
          log: (record) => {
            records.push(record);
          },
        }),
      ).toBe(status === "failed" ? 1 : 0);
      expect(records.at(0)).toMatchObject({
        status,
        "case_law.eu_completion.rows_failed": 1,
        "case_law.eu_completion.failed": Number(status === "failed"),
      });
    }
  });

  test("throwing ticks fail visibly instead of losing the heartbeat", async () => {
    const records: unknown[] = [];
    expect(
      await runEuCompletionTickScript({
        environment,
        runEnabled: async () => {
          throw new DOMException("Fixture cancellation", "AbortError");
        },
        log: (record) => {
          records.push(record);
        },
      }),
    ).toBe(1);
    expect(records).toHaveLength(2);
    expect(records.at(0)).toMatchObject({
      status: "failed",
      "case_law.eu_completion.failed": 1,
    });
    expect(records.at(1)).toMatchObject({
      event: "case_law.eu_completion.tick_failure",
    });
  });

  test("queue telemetry reports bounded presence and ages without inventing missing-part counts", () => {
    const record = euCompletionQueueMetricRecord({
      mode: "apply",
      timestamp: 1000,
      probe: {
        hasQueuedWork: true,
        mirrorRepairRequired: true,
        oldestRetryAgeMs: 20,
        lastCompletedAt: new Date(900),
      },
    });
    expect(record).toMatchObject({
      "case_law.eu_completion.queued_work_present": 1,
      "case_law.eu_completion.mirror_repair_required_present": 1,
      "case_law.eu_completion.oldest_retry_age_ms": 20,
      "case_law.eu_completion.last_success_age_ms": 100,
    });
    const absent = euCompletionQueueMetricRecord({
      mode: "apply",
      timestamp: 1000,
      probe: {
        hasQueuedWork: false,
        mirrorRepairRequired: false,
        oldestRetryAgeMs: null,
        lastCompletedAt: null,
      },
    });
    expect(absent).not.toHaveProperty(
      "case_law.eu_completion.last_success_age_ms",
    );
    expect(absent).not.toHaveProperty(
      "case_law.eu_completion.oldest_retry_age_ms",
    );
  });

  test("metric dimensions contain neither document ids nor publisher URLs", () => {
    const record = euCompletionMetricRecord({
      report: report("publisher-refused"),
      mode: "apply",
      enabled: true,
      timestamp: 123,
    });
    expect(record._aws.CloudWatchMetrics.at(0)?.Dimensions).toEqual([
      ["AdapterKey", "Mode"],
    ]);
    expect(record).toMatchObject({
      "case_law.eu_completion.publisher_refused": 1,
      "case_law.eu_completion.requests": 1,
    });
    expect("decisionId" in record).toBe(false);
    expect("sourceId" in record).toBe(false);
  });

  test("environment defaults are dormant, reads fresh switches, and rejects invalid row budgets", () => {
    const previous = {
      CASE_LAW_EU_COMPLETION_ENABLED:
        process.env["CASE_LAW_EU_COMPLETION_ENABLED"],
      CASE_LAW_EU_COMPLETION_KILL_SWITCH:
        process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"],
      CASE_LAW_EU_COMPLETION_MODE: process.env["CASE_LAW_EU_COMPLETION_MODE"],
      CASE_LAW_EU_COMPLETION_MAX_ROWS:
        process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"],
    };
    try {
      delete process.env["CASE_LAW_EU_COMPLETION_ENABLED"];
      delete process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"];
      delete process.env["CASE_LAW_EU_COMPLETION_MODE"];
      delete process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"];
      expect(readEuCompletionTickEnvironment()).toEqual({
        ...environment,
        CASE_LAW_EU_COMPLETION_ENABLED: false,
      });
      process.env["CASE_LAW_EU_COMPLETION_ENABLED"] = "true";
      process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"] = "true";
      expect(readEuCompletionTickEnvironment()).toMatchObject({
        CASE_LAW_EU_COMPLETION_ENABLED: true,
        CASE_LAW_EU_COMPLETION_KILL_SWITCH: true,
      });
      for (const value of ["0", "101", "1.5", "NaN"]) {
        process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"] = value;
        expect(readEuCompletionTickEnvironment).toThrow(ValiError);
      }
    } finally {
      if (previous.CASE_LAW_EU_COMPLETION_ENABLED === undefined) {
        delete process.env["CASE_LAW_EU_COMPLETION_ENABLED"];
      } else {
        process.env["CASE_LAW_EU_COMPLETION_ENABLED"] =
          previous.CASE_LAW_EU_COMPLETION_ENABLED;
      }
      if (previous.CASE_LAW_EU_COMPLETION_KILL_SWITCH === undefined) {
        delete process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"];
      } else {
        process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"] =
          previous.CASE_LAW_EU_COMPLETION_KILL_SWITCH;
      }
      if (previous.CASE_LAW_EU_COMPLETION_MODE === undefined) {
        delete process.env["CASE_LAW_EU_COMPLETION_MODE"];
      } else {
        process.env["CASE_LAW_EU_COMPLETION_MODE"] =
          previous.CASE_LAW_EU_COMPLETION_MODE;
      }
      if (previous.CASE_LAW_EU_COMPLETION_MAX_ROWS === undefined) {
        delete process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"];
      } else {
        process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"] =
          previous.CASE_LAW_EU_COMPLETION_MAX_ROWS;
      }
    }
  });
});
