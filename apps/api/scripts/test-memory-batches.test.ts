import { expect, test } from "bun:test";
import fc from "fast-check";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import { listApiTestPaths, planApiTestBatches } from "./api-test-plan";
import {
  batchPeakRss,
  composeTestBatches,
  measuredTestRssTable,
  MIN_TEST_RSS_CLASS_MEASUREMENTS,
  parseRssMeasurementArguments,
  readTestRssTable,
  SOLO_TEST_RSS_RATIO,
  splitMemoryBoundedBatches,
  staleTestRssTableAnnotation,
  TEST_BATCH_RSS_HEADROOM_RATIO,
  TEST_RSS_TABLE_MAX_AGE_DAYS,
  testRssArtifact,
  unmeasuredTestPeakRss,
  type TestRssTable,
} from "./test-batch-plan";
import { partitionTestFiles } from "./test-file-shards";

// Only the db class has its own unmeasured estimate; these cases are ordinary.
const NO_DB_TESTS: ReadonlySet<string> = new Set();

const BUDGET_MB = 2560;
const ENVIRONMENT = {
  os: "linux",
  arch: "x64",
  bunVersion: "fixture",
  runnerImage: "fixture",
};
const SOURCE = { runId: "1", job: "measure-1" };
const MEASURED_AT = "2026-10-04T03:10:00.000Z";
const calibrated = (
  baselineMb: number,
  files: Readonly<Record<string, number>>,
): TestRssTable => ({
  environment: ENVIRONMENT,
  measuredAt: MEASURED_AT,
  baselineMb,
  files: Object.fromEntries(
    Object.entries(files).map(([file, peakMb]) => [
      file,
      { peakMb, baselineMb, source: SOURCE },
    ]),
  ),
});

test("measured files at sixty percent of their class cap always run alone", () => {
  expect(
    splitMemoryBoundedBatches({
      batches: [["small", "threshold", "last"]],
      rssTable: calibrated(10, {
        small: 20,
        threshold: 10 + BUDGET_MB * SOLO_TEST_RSS_RATIO,
        last: 20,
      }),
      budgetMb: BUDGET_MB,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toEqual([["small"], ["threshold"], ["last"]]);
});
const measuredClass = (
  prefix: string,
  increments: readonly number[],
  baselineMb = 100,
) =>
  Object.fromEntries(
    increments.map((increment, index) => [
      `${prefix}-${index}`,
      baselineMb + increment,
    ]),
  );

test("unmeasured estimates follow each execution class profile", () => {
  const dbIncrements = Array.from(
    { length: MIN_TEST_RSS_CLASS_MEASUREMENTS },
    () => 100,
  );
  dbIncrements[18] = 900;
  dbIncrements[19] = 1200;
  const dbMeasurements = measuredClass("db", dbIncrements);
  const unitMeasurements = measuredClass(
    "unit",
    Array.from({ length: MIN_TEST_RSS_CLASS_MEASUREMENTS }, () => 100),
  );
  const rssTable = calibrated(100, {
    ...dbMeasurements,
    ...unitMeasurements,
  });
  const dbTestPaths = new Set([
    ...Object.keys(dbMeasurements),
    "new-db-a",
    "new-db-b",
  ]);

  expect(
    unmeasuredTestPeakRss({
      file: "new-db-a",
      rssTable,
      dbTestPaths,
      budgetMb: BUDGET_MB,
    }),
  ).toBe(900);
  expect(
    splitMemoryBoundedBatches({
      batches: [
        ["new-db-a", "new-db-b"],
        ["unit-a", "unit-b", "unit-c"],
      ],
      rssTable,
      budgetMb: BUDGET_MB,
      dbTestPaths,
    }),
  ).toEqual([["new-db-a"], ["new-db-b"], ["unit-a", "unit-b", "unit-c"]]);
});
test("unmeasured estimates track percentile changes and sparse classes fall back", () => {
  const increments = Array.from(
    { length: MIN_TEST_RSS_CLASS_MEASUREMENTS },
    () => 100,
  );
  increments[18] = 600;
  increments[19] = 1000;
  const dbTestPaths = new Set([
    ...Object.keys(measuredClass("db", increments)),
    "new-db",
  ]);
  const estimate = (values: readonly number[]) =>
    unmeasuredTestPeakRss({
      file: "new-db",
      rssTable: calibrated(100, measuredClass("db", values)),
      dbTestPaths,
      budgetMb: BUDGET_MB,
    });

  expect(estimate(increments)).toBe(600);
  expect(estimate(increments.with(18, 800))).toBe(800);
  expect(estimate(increments.slice(1))).toBe(Math.ceil(BUDGET_MB * 0.7 * 0.4));
});
test("shared composition counts the preload baseline exactly once", () => {
  const rssTable = calibrated(1000, { a: 1110, b: 1110, c: 1110, d: 1110 });
  expect(
    batchPeakRss({
      files: ["a", "b"],
      rssTable,
      budgetMb: 2000,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toBe(1220);
  expect(
    splitMemoryBoundedBatches({
      batches: [["a", "b", "c", "d"]],
      rssTable,
      budgetMb: 2000,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toEqual([["a", "b", "c"], ["d"]]);
});
test("per-file increments retain their own shard baseline", () => {
  const rssTable = {
    baselineMb: 1000,
    environment: ENVIRONMENT,
    measuredAt: MEASURED_AT,
    files: {
      a: { peakMb: 1100, baselineMb: 1000, source: SOURCE },
      b: { peakMb: 1100, baselineMb: 500, source: SOURCE },
    },
  } as const satisfies TestRssTable;
  expect(
    batchPeakRss({
      files: ["a", "b"],
      rssTable,
      budgetMb: 2560,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toBe(1700);
});
test("solo isolation uses the planned singleton peak, not the shard's raw peak", () => {
  // Raw peak 1100 MB is below the 60% threshold, but on the table baseline
  // the file needs 1000 + 700 = 1700 MB, which is above it.
  const rssTable = {
    baselineMb: 1000,
    environment: ENVIRONMENT,
    measuredAt: MEASURED_AT,
    files: {
      a: { peakMb: 1100, baselineMb: 400, source: SOURCE },
      b: { peakMb: 1050, baselineMb: 1000, source: SOURCE },
    },
  } as const satisfies TestRssTable;
  expect(
    splitMemoryBoundedBatches({
      batches: [["a", "b"]],
      rssTable,
      budgetMb: BUDGET_MB,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toEqual([["a"], ["b"]]);
});
test("a noisy peak below its preload cannot reduce another file's estimate", () => {
  const rssTable = calibrated(1000, { a: 900, b: 1110 });
  expect(
    batchPeakRss({
      files: ["a", "b"],
      rssTable,
      budgetMb: 2000,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toBe(1110);
});
test("impossible plans fail before running and name their files and class cap", () => {
  expect(() =>
    splitMemoryBoundedBatches({
      batches: [["small", "too-big"]],
      rssTable: calibrated(10, { small: 20, "too-big": BUDGET_MB + 1 }),
      budgetMb: BUDGET_MB,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toThrow(
    "Cannot plan API test batch [small, too-big]: too-big requires 2561 MB, class budget 2560 MB",
  );
  expect(() =>
    splitMemoryBoundedBatches({
      batches: [["unknown"]],
      rssTable: calibrated(2000, {}),
      budgetMb: BUDGET_MB,
      dbTestPaths: NO_DB_TESTS,
    }),
  ).toThrow("unknown requires 2717 MB, class budget 2560 MB");
});
test("calibrated splitting preserves every file and never exceeds its composition model", () => {
  assertProperty(
    "calibrated splitting preserves every file and never exceeds its composition model",
    fc.property(
      fc.integer({ min: 500, max: 5000 }),
      fc.integer({ min: 1, max: 400 }),
      fc.array(
        fc.option(fc.integer({ min: 1, max: 5000 }), { nil: undefined }),
        { maxLength: 60 },
      ),
      fc.integer({ min: 1, max: 8 }),
      (budgetMb, baselineObservation, observations, shardCount) => {
        const baselineMb = Math.min(
          baselineObservation,
          Math.floor(budgetMb * 0.4),
        );
        const files = observations.map((_, index) => `file-${index}`);
        const dbTestPaths = new Set(
          files.filter((_, index) => index % 2 === 0),
        );
        const measurements: Record<string, number> = {};
        for (const [index, observation] of observations.entries()) {
          if (observation !== undefined) {
            measurements[`file-${index}`] = Math.max(
              baselineMb,
              (observation % budgetMb) + 1,
            );
          }
        }
        const rssTable = calibrated(baselineMb, measurements);
        const shards = partitionTestFiles({
          files,
          durations: {},
          count: shardCount,
        });
        const planned = shards.flatMap((shard) => {
          const original = composeTestBatches(shard, 8);
          const batches = splitMemoryBoundedBatches({
            batches: original,
            rssTable,
            budgetMb,
            dbTestPaths,
          });
          expect(batches.flat()).toEqual(shard);
          // Stable plans keep shard and batch neighbours from churning between runs.
          expect(
            splitMemoryBoundedBatches({
              batches: original,
              rssTable,
              budgetMb,
              dbTestPaths,
            }),
          ).toEqual(batches);
          for (const batch of batches) {
            expect(
              original.some((source) =>
                batch.every((file) => source.includes(file)),
              ),
            ).toBe(true);
            for (const file of batch) {
              const peak = measurements[file];
              if (peak !== undefined && peak >= budgetMb * 0.6) {
                expect(batch).toHaveLength(1);
              }
            }
            const estimate = batchPeakRss({
              files: batch,
              rssTable,
              budgetMb,
              dbTestPaths,
            });
            expect(estimate).toBeLessThanOrEqual(budgetMb);
            if (batch.length > 1) {
              expect(estimate).toBeLessThanOrEqual(budgetMb * 0.7);
            }
          }
          return batches;
        });
        expect(planned.flat().toSorted()).toEqual(files.toSorted());
        expect(new Set(planned.flat()).size).toBe(files.length);
      },
    ),
  );
});
test("invalid observations and budgets fail before composition", () => {
  for (const budgetMb of [0, -1, Infinity, Number.NaN]) {
    expect(() =>
      splitMemoryBoundedBatches({
        batches: [],
        rssTable: calibrated(10, {}),
        budgetMb,
        dbTestPaths: NO_DB_TESTS,
      }),
    ).toThrow("memory budget must be positive and finite");
  }
  for (const weight of [0, -1, Infinity, Number.NaN]) {
    expect(() =>
      splitMemoryBoundedBatches({
        batches: [["bad"]],
        rssTable: calibrated(10, { bad: weight }),
        budgetMb: BUDGET_MB,
        dbTestPaths: NO_DB_TESTS,
      }),
    ).toThrow("Invalid peak RSS for bad");
  }
  expect(() =>
    readTestRssTable({
      baselineMb: 100,
      environment: ENVIRONMENT,
      measuredAt: MEASURED_AT,
      files: { bad: { peakMb: 100, baselineMb: 200, source: SOURCE } },
    }),
  ).toThrow("Table baseline is below the measured baseline for bad");
  for (const measuredAt of [undefined, "2026-10-04", "not a date"]) {
    expect(() =>
      readTestRssTable({
        baselineMb: 100,
        environment: ENVIRONMENT,
        measuredAt,
        files: {},
      }),
    ).toThrow("Invalid RSS measurement time");
  }
});
test("measurement mode composes fresh children without consulting normal estimates", async () => {
  const testPaths = [
    "scripts/resource-usage.test.ts",
    "scripts/test-lanes.test.ts",
  ];
  const groups = await planApiTestBatches({
    apiRoot: path.resolve(import.meta.dir, ".."),
    propertyOnly: false,
    testPaths,
    executionMode: "measure-rss",
  });
  expect(
    groups
      .flatMap(({ testBatches }) => testBatches)
      .toSorted((left, right) =>
        compareCodeUnit(left.join("\0"), right.join("\0")),
      ),
  ).toEqual(testPaths.toSorted().map((file) => [file]));
});
test("a partial or property-only plan classifies every measured file like a full plan", async () => {
  const apiRoot = path.resolve(import.meta.dir, "..");
  const measured = Object.keys(measuredTestRssTable().files);
  const dbClass = async (
    testPaths: readonly string[],
    propertyOnly: boolean,
  ) => {
    const [group] = await planApiTestBatches({
      apiRoot,
      propertyOnly,
      testPaths,
    });
    const dbTestPaths = group?.dbTestPaths ?? new Set<string>();
    return measured.filter((file) => dbTestPaths.has(file)).toSorted();
  };
  const full = await dbClass(listApiTestPaths(apiRoot), false);
  expect(full.length).toBeGreaterThan(0);
  expect(await dbClass(["scripts/resource-usage.test.ts"], false)).toEqual(
    full,
  );
  expect(await dbClass(["scripts/resource-usage.test.ts"], true)).toEqual(full);
  expect(await dbClass(listApiTestPaths(apiRoot), true)).toEqual(full);
});
test("measurement arguments preserve provenance without entering test filters", () => {
  const options = parseRssMeasurementArguments([
    "--measure-rss",
    "out.json",
    "--measure-rss-image",
    "ubuntu:1",
    "--measure-rss-source",
    '{"runId":"42","job":"measure-2"}',
    "scripts/one.test.ts",
  ]);
  expect(options.mode).toBe("measure-rss");
  if (options.mode === "measure-rss") {
    expect(options.outputPath).toBe("out.json");
    expect(options.environment.runnerImage).toBe("ubuntu:1");
    expect(options.source).toEqual({ runId: "42", job: "measure-2" });
    expect(options.arguments).toEqual(["scripts/one.test.ts"]);
  }
  expect(parseRssMeasurementArguments(["file"])).toEqual({
    mode: "batched",
    arguments: ["file"],
  });
  for (const args of [
    ["--measure-rss"],
    ["--measure-rss", "--bail"],
    ["--measure-rss", "out", "--property"],
    ["--measure-rss", "out", "--measure-rss", "other"],
  ]) {
    expect(() => parseRssMeasurementArguments(args)).toThrow(
      "Usage: --measure-rss",
    );
  }
});
test("receipts preserve singleton peaks and baseline metadata", () => {
  const receipt = JSON.parse(
    testRssArtifact({
      environment: ENVIRONMENT,
      source: SOURCE,
      measuredAt: MEASURED_AT,
      baselineMb: 100,
      measurements: [{ file: "scripts/one.test.ts", peakMb: 700, exitCode: 0 }],
      shard: { index: 2, count: 4 },
      plannedFiles: 1,
    }),
  );
  expect(receipt).toEqual({
    version: 3,
    environment: ENVIRONMENT,
    source: SOURCE,
    measuredAt: MEASURED_AT,
    shard: { index: 2, count: 4 },
    plannedFiles: 1,
    baselineMb: 100,
    measurements: [{ file: "scripts/one.test.ts", peakMb: 700, exitCode: 0 }],
  });
});
test("the memory profile warns only once it is more than the maximum age old", () => {
  const DAY_MS = 86_400_000;
  const measured = Date.parse(MEASURED_AT);
  const at = (offsetMs: number) => new Date(measured + offsetMs);
  const limitMs = TEST_RSS_TABLE_MAX_AGE_DAYS * DAY_MS;
  for (const offsetMs of [-DAY_MS, 0, DAY_MS, limitMs, limitMs + DAY_MS - 1]) {
    expect(staleTestRssTableAnnotation(MEASURED_AT, at(offsetMs))).toBe(
      undefined,
    );
  }
  expect(staleTestRssTableAnnotation(MEASURED_AT, at(limitMs + DAY_MS))).toBe(
    "::warning title=API test memory profile is stale::" +
      "apps/api/scripts/test-peak-rss.json was measured 15 days ago " +
      `(${MEASURED_AT}), more than 14; merge the open refresh pull request ` +
      "or rerun the API test memory workflow (docs/test-memory.md)",
  );
});
test("every production batch fits its cap, and every shared batch its measured headroom", async () => {
  const apiRoot = path.resolve(import.meta.dir, "..");
  const files = listApiTestPaths(apiRoot);
  const groups = await planApiTestBatches({
    apiRoot,
    propertyOnly: false,
    testPaths: files,
  });
  const table = measuredTestRssTable();
  const planned = groups.flatMap(({ testBatches, maxPeakRssMb, dbTestPaths }) =>
    testBatches.map((batch) => ({
      batch,
      budgetMb: maxPeakRssMb,
      dbTestPaths,
    })),
  );
  expect(planned.flatMap(({ batch }) => batch).toSorted()).toEqual(files);
  for (const { batch, budgetMb, dbTestPaths } of planned) {
    const estimate = batchPeakRss({
      files: batch,
      rssTable: table,
      budgetMb,
      dbTestPaths,
    });
    expect({ batch, estimate }).toEqual({
      batch,
      estimate: Math.min(
        estimate,
        batch.length > 1 ? budgetMb * TEST_BATCH_RSS_HEADROOM_RATIO : budgetMb,
      ),
    });
  }
}, 20_000);
