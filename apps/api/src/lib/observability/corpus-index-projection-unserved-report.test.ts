import { Result } from "better-result";
import { afterEach, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import "@/api/tests/setup-env";
import { CorpusProjectionUnservedReadError } from "@/api/lib/legal-search/corpus-index-projection-unserved";
import {
  type CorpusProjectionUnservedReport,
  emitCorpusProjectionUnservedReport,
} from "@/api/lib/observability/corpus-index-projection-unserved-report";
import {
  CORPUS_PROJECTION_UNSERVED_METRIC,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { reportCaseLawFreshnessTask } from "@/api/lib/scheduler/tasks/case-law-freshness-report";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

afterEach(resetMetricLineSinkForTesting);

const NOW = Temporal.Instant.from("2026-11-14T12:00:00Z");
const minutesAgo = (minutes: number) => NOW.subtract({ minutes });

const captureLines = (): Record<string, unknown>[] => {
  const records: Record<string, unknown>[] = [];
  setMetricLineSinkForTesting((line) => {
    records.push(JSON.parse(line));
  });
  return records;
};

const freshnessReport = {
  backlogItems: 0,
  backlogCapped: false,
  oldestUnpublishedAge: { type: "no-backlog" },
  sourceAges: [],
  convergence: null,
  lastCompletedIdentifierPass: null,
} as const;

test("each kind reports its generation and each index with an unserved entity", () => {
  const records = captureLines();
  const report = [
    {
      family: "case_law",
      generation: "case_law_v7",
      counts: {
        at_risk: {
          type: "exact",
          byIndex: [
            {
              indexId: "case_law_v7_cs_sk",
              count: 4,
              oldest: { type: "exact", since: minutesAgo(30) },
            },
            {
              indexId: "case_law_v7_pol",
              count: 2,
              oldest: { type: "exact", since: minutesAgo(90) },
            },
          ],
        },
        absent: { type: "exact", byIndex: [] },
      },
    },
  ] as const satisfies CorpusProjectionUnservedReport;

  emitCorpusProjectionUnservedReport(report, NOW);

  expect(records).toEqual([
    {
      CorpusProjectionUnservedEntities: 6,
      CorpusProjectionUnservedOldestAgeSeconds: 5400,
      family: "case_law",
      generation: "case_law_v7",
      kind: "at_risk",
      scope: "generation",
      countBound: "exact",
    },
    {
      CorpusProjectionUnservedEntities: 4,
      CorpusProjectionUnservedOldestAgeSeconds: 1800,
      family: "case_law",
      generation: "case_law_v7",
      kind: "at_risk",
      scope: "index",
      indexId: "case_law_v7_cs_sk",
      countBound: "exact",
    },
    {
      CorpusProjectionUnservedEntities: 2,
      CorpusProjectionUnservedOldestAgeSeconds: 5400,
      family: "case_law",
      generation: "case_law_v7",
      kind: "at_risk",
      scope: "index",
      indexId: "case_law_v7_pol",
      countBound: "exact",
    },
    {
      CorpusProjectionUnservedEntities: 0,
      CorpusProjectionUnservedOldestAgeSeconds: 0,
      family: "case_law",
      generation: "case_law_v7",
      kind: "absent",
      scope: "generation",
      countBound: "exact",
    },
  ]);
});

test("a stopped walk reports a lower bound and no age it cannot know", () => {
  const records = captureLines();
  emitCorpusProjectionUnservedReport(
    [
      {
        family: "legislation",
        generation: "legislation_v3",
        counts: {
          at_risk: { type: "at_least", byIndex: [] },
          absent: {
            type: "at_least",
            byIndex: [
              {
                indexId: "legislation_v3_cze",
                count: 101,
                oldest: { type: "unknown" },
              },
            ],
          },
        },
      },
    ],
    NOW,
  );

  expect(records.map((record) => record["countBound"])).toEqual([
    "at_least",
    "at_least",
    "at_least",
  ]);
  expect(
    records.filter(
      (record) => CORPUS_PROJECTION_UNSERVED_METRIC.oldestAgeSeconds in record,
    ),
  ).toEqual([]);
});

test("a failed gauge read emits no gauge, not zero, and the task succeeds", async () => {
  const records = captureLines();
  const reads: unknown[] = [
    freshnessReport,
    Result.err(
      new CorpusProjectionUnservedReadError({
        message: "read failed",
        cause: null,
      }),
    ),
    [],
  ];
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
  expect(
    records.filter(
      (record) => CORPUS_PROJECTION_UNSERVED_METRIC.entities in record,
    ),
  ).toEqual([]);
});
