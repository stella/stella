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
  backlogItems: 3,
  backlogCapped: false,
  oldestUnpublishedAgeSeconds: 42,
  oldestUnpublishedAgeSource: "desired_at",
  sourceAges: [{ source: "cz-ns", ageSeconds: 19 }],
  convergence: "pending",
} as const;

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
