import { afterEach, expect, test } from "bun:test";

import "@/api/tests/setup-env";
import {
  emitCaseLawFreshnessReport,
  runCaseLawFreshnessMetricTick,
} from "@/api/lib/observability/case-law-freshness-metrics";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

afterEach(resetMetricLineSinkForTesting);

const report = {
  backlogItems: 3,
  oldestUnpublishedAgeSeconds: 42,
  sourceAges: [{ source: "cz-ns", ageSeconds: 19 }],
  convergence: "pending",
} as const;

test("emits one owned EMF record per metric with only its bounded dimension", () => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => records.push(JSON.parse(line)));
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

test("two loop instances sharing the advisory lock emit once", async () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => lines.push(line));
  let held = false;
  const openSession = async (
    work: (session: {
      tryLock: () => Promise<boolean>;
      read: () => Promise<typeof report>;
    }) => Promise<void>,
  ) => {
    await work({
      tryLock: async () => {
        if (held) {
          return false;
        }
        held = true;
        return true;
      },
      read: () => Promise.resolve(report),
    });
  };

  await Promise.all([
    runCaseLawFreshnessMetricTick(openSession),
    runCaseLawFreshnessMetricTick(openSession),
  ]);
  expect(lines).toHaveLength(4);
});
