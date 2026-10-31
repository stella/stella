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
  oldestUnpublishedAge: { type: "measured", seconds: 42, source: "desired_at" },
  sourceAges: [{ source: "cz-ns", ageSeconds: 19 }],
  convergence: "pending",
  lastCompletedIdentifierPass: { repairs: 2, ageSeconds: 120 },
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
  expect(records).toHaveLength(5);
});

test("emits one owned EMF record per metric with only its bounded dimension", () => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => {
    records.push(JSON.parse(line));
  });
  emitCaseLawFreshnessReport(report);

  expect(records).toHaveLength(6);
  expect(
    records.map((record) =>
      Object.keys(record).filter((key) => key !== "_aws"),
    ),
  ).toEqual([
    ["CaseLawProjectionBacklogItems"],
    ["CaseLawOldestUnpublishedAgeSeconds"],
    ["CaseLawSourceSyncAgeSeconds", "source"],
    ["CaseLawDecisionIdentifierRepairs"],
    ["CaseLawDecisionIdentifierPassAgeSeconds"],
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
          Dimensions: [[]],
          Metrics: [
            { Name: "CaseLawDecisionIdentifierRepairs", Unit: "Count" },
          ],
        }),
      ],
    }),
    expect.objectContaining({
      CloudWatchMetrics: [
        expect.objectContaining({
          Dimensions: [[]],
          Metrics: [
            {
              Name: "CaseLawDecisionIdentifierPassAgeSeconds",
              Unit: "Seconds",
            },
          ],
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

test("a never-completed identifier pass emits no completion metrics", () => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => {
    records.push(JSON.parse(line));
  });
  emitCaseLawFreshnessReport({
    ...report,
    lastCompletedIdentifierPass: null,
  });

  expect(records).toHaveLength(4);
  expect(
    records.flatMap((record) =>
      Object.keys(record).filter((key) => key !== "_aws"),
    ),
  ).not.toContain("CaseLawDecisionIdentifierPassAgeSeconds");
  expect(
    records.flatMap((record) =>
      Object.keys(record).filter((key) => key !== "_aws"),
    ),
  ).not.toContain("CaseLawDecisionIdentifierRepairs");
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
  expect(lines).toHaveLength(6);
});
