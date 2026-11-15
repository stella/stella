import { Result } from "better-result";
import { afterEach, expect, test } from "bun:test";

import "@/api/tests/setup-env";
import { emitCaseLawFreshnessReport } from "@/api/lib/observability/case-law-freshness-metrics";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
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
  waitingReplacements: [],
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

  expect(records.flatMap((record) => Object.keys(record))).not.toContain(
    "CaseLawOldestUnpublishedAgeSeconds",
  );
  expect(records).toHaveLength(5);
});

test("emits one record per metric with bounded top-level fields", () => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => {
    records.push(JSON.parse(line));
  });
  emitCaseLawFreshnessReport(report);

  expect(records).toHaveLength(6);
  expect(records).toEqual([
    { CaseLawProjectionBacklogItems: 3 },
    { CaseLawOldestUnpublishedAgeSeconds: 42 },
    { CaseLawSourceSyncAgeSeconds: 19, source: "cz-ns" },
    { CaseLawDecisionIdentifierRepairs: 2 },
    { CaseLawDecisionIdentifierPassAgeSeconds: 120 },
    { CaseLawProjectionConvergence: 1, status: "pending" },
  ]);
});

test("waiting replacements emit a count and an oldest age per index", () => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => {
    records.push(JSON.parse(line));
  });
  emitCaseLawFreshnessReport({
    ...report,
    waitingReplacements: [
      {
        generation: "case_law_v7",
        indexId: "case_law_v7_cs_sk",
        count: 12,
        oldestSeconds: 3600,
      },
    ],
  });

  expect(records.slice(-2)).toEqual([
    {
      CaseLawProjectionWaitingReplacements: 12,
      generation: "case_law_v7",
      index: "case_law_v7_cs_sk",
    },
    {
      CaseLawProjectionWaitingReplacementOldestSeconds: 3600,
      generation: "case_law_v7",
      index: "case_law_v7_cs_sk",
    },
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
  expect(records.flatMap((record) => Object.keys(record))).not.toContain(
    "CaseLawDecisionIdentifierPassAgeSeconds",
  );
  expect(records.flatMap((record) => Object.keys(record))).not.toContain(
    "CaseLawDecisionIdentifierRepairs",
  );
});

test("the scheduler task reads and emits one report per run", async () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  // The freshness read first, then the unserved gauge and the served
  // generations the split census counts; none are served here, so neither
  // emits a record and the census reads no corpus index.
  const reads: unknown[] = [report, Result.ok([]), []];
  let transactions = 0;
  await reportCaseLawFreshnessTask(
    asTestRaw<SchedulerTaskContext>({
      dueAt: DueSlot.of({ nextRunAt: new Date("2026-11-14T12:00:00Z") }),
      db: asTestRaw({
        transaction: async () => {
          const read = reads[transactions];
          transactions += 1;
          return await Promise.resolve(read);
        },
      }),
    }),
  );
  expect(transactions).toBe(3);
  expect(lines).toHaveLength(6);
});

test("a failed split census read leaves the freshness task successful", async () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  let transactions = 0;
  const run = reportCaseLawFreshnessTask(
    asTestRaw<SchedulerTaskContext>({
      dueAt: DueSlot.of({ nextRunAt: new Date("2026-11-14T12:00:00Z") }),
      db: asTestRaw({
        transaction: async () => {
          transactions += 1;
          if (transactions === 1) {
            return await Promise.resolve(report);
          }
          throw new Error("census read failed");
        },
      }),
    }),
  );

  expect(await run).toBeUndefined();
  expect(transactions).toBe(3);
  expect(lines).toHaveLength(6);
});
