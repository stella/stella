import { afterEach, expect, test } from "bun:test";

import "@/api/tests/setup-env";
import { emitCaseLawFreshnessReport } from "@/api/lib/observability/case-law-freshness-metrics";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { reportCaseLawFreshnessTask } from "@/api/lib/scheduler/tasks/case-law-freshness-report";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

afterEach(resetMetricLineSinkForTesting);

const report = {
  fulltextHealth: [],
  backlogItems: 3,
  backlogCapped: false,
  oldestUnpublishedAge: { type: "measured", seconds: 42, source: "desired_at" },
  sourceAges: [{ source: "cz-ns", ageSeconds: 19 }],
  convergence: "pending",
} as const;

test("an incomplete oldest age emits no age record", () => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => {
    records.push(JSON.parse(line));
  });
  emitCaseLawFreshnessReport({
    ...report,
    backlogCapped: true,
    oldestUnpublishedAge: { type: "incomplete" },
  });

  expect(
    records.flatMap((record) =>
      Object.keys(record).filter((key) => key !== "_aws"),
    ),
  ).not.toContain("CaseLawOldestUnpublishedAgeSeconds");
  expect(records).toHaveLength(3);
});

test("emits one owned EMF record per metric with only its bounded dimension", () => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => {
    records.push(JSON.parse(line));
  });
  emitCaseLawFreshnessReport(report);

  expect(records).toHaveLength(4);
  expect(
    records.map((record) =>
      Object.keys(record).filter((key) => key !== "_aws"),
    ),
  ).toEqual([
    ["CaseLawProjectionBacklogItems"],
    ["CaseLawOldestUnpublishedAgeSeconds"],
    ["CaseLawSourceSyncAgeSeconds", "source"],
    ["CaseLawProjectionConvergence", "status"],
  ]);
  expect(records.map((record) => record["_aws"])).toEqual([
    expect.objectContaining({
      CloudWatchMetrics: [
        expect.objectContaining({
          Dimensions: [[]],
          Metrics: [{ Name: "CaseLawProjectionBacklogItems", Unit: "Count" }],
        }),
      ],
    }),
    expect.objectContaining({
      CloudWatchMetrics: [
        expect.objectContaining({
          Dimensions: [[]],
          Metrics: [
            { Name: "CaseLawOldestUnpublishedAgeSeconds", Unit: "Seconds" },
          ],
        }),
      ],
    }),
    expect.objectContaining({
      CloudWatchMetrics: [
        expect.objectContaining({
          Dimensions: [["source"]],
          Metrics: [{ Name: "CaseLawSourceSyncAgeSeconds", Unit: "Seconds" }],
        }),
      ],
    }),
    expect.objectContaining({
      CloudWatchMetrics: [
        expect.objectContaining({
          Dimensions: [["status"]],
          Metrics: [{ Name: "CaseLawProjectionConvergence", Unit: "Count" }],
        }),
      ],
    }),
  ]);
});

test("the scheduler task reads and emits one report per run", async () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  let transactions = 0;
  await reportCaseLawFreshnessTask(
    asTestRaw<SchedulerTaskContext>({
      db: asTestRaw({
        transaction: async () => {
          transactions += 1;
          return await Promise.resolve(report);
        },
      }),
    }),
  );
  expect(transactions).toBe(1);
  expect(lines).toHaveLength(4);
});

test.each([
  { missingState: true, failed: { type: "exact", count: 0 } },
  { missingState: false, failed: { type: "at-least", count: 101 } },
] as const)(
  "full-text invariant breaches emit their report before failing the scheduler: %j",
  async (health) => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    const outcome = await reportCaseLawFreshnessTask(
      asTestRaw<SchedulerTaskContext>({
        db: asTestRaw({
          transaction: async () => ({
            ...report,
            fulltextHealth: [
              { source: "cz-ns", failedThreshold: 100, ...health },
            ],
          }),
        }),
      }),
    );
    expect(outcome).toMatchObject({
      status: "error",
      error: {
        _tag: "SchedulerTaskFailure",
        message: "Case-law full-text invariant health breached",
      },
    });
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        CaseLawTextStateMissing: health.missingState ? 1 : 0,
        source: "cz-ns",
      }),
    );
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        CaseLawTextFailedOverThreshold: health.failed.count > 100 ? 1 : 0,
        source: "cz-ns",
      }),
    );
  },
);

test("a source at its failure threshold emits clear gauges and the scheduler succeeds", async () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  const outcome = await reportCaseLawFreshnessTask(
    asTestRaw<SchedulerTaskContext>({
      db: asTestRaw({
        transaction: async () => ({
          ...report,
          fulltextHealth: [
            {
              source: "cz-ns",
              missingState: false,
              failedThreshold: 100,
              failed: { type: "exact", count: 100 },
            },
          ],
        }),
      }),
    }),
  );
  expect(outcome).toMatchObject({ status: "ok" });
  expect(lines.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({ CaseLawTextStateMissing: 0, source: "cz-ns" }),
  );
  expect(lines.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      CaseLawTextFailedOverThreshold: 0,
      source: "cz-ns",
    }),
  );
});
