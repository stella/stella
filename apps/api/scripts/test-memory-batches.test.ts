import { expect, test } from "bun:test";
import fc from "fast-check";
import path from "node:path";

import { propertyConfig } from "@stll/property-testing";

import { planApiTestBatches } from "./api-test-plan";
import {
  composeTestBatches,
  DEFAULT_TEST_PEAK_RSS_MB,
  splitMemoryBoundedBatches,
  TEST_BATCH_RSS_HEADROOM_RATIO,
} from "./test-batch-plan";
import { partitionTestFiles } from "./test-file-shards";
import peakRssMb from "./test-peak-rss.json";

const BUDGET_MB = 2560 * 0.7;

test("measured heavy files cannot share a process above the memory budget", () => {
  const files = Object.keys(peakRssMb);
  expect(files.length).toBeGreaterThanOrEqual(2);
  expect(
    splitMemoryBoundedBatches({
      batches: [files],
      peakRssMb,
      budgetMb: BUDGET_MB,
    }),
  ).toEqual(files.map((file) => [file]));
});

test("the runner applies memory limits while preserving the shard census", async () => {
  const files = [...Object.keys(peakRssMb), "scripts/test-file-shards.test.ts"];
  const measurements = new Map(Object.entries(peakRssMb));
  for (const count of [1, 4]) {
    const shards = partitionTestFiles({ files, durations: {}, count });
    const plannedFiles: string[] = [];
    for (const testPaths of shards) {
      const groups = await planApiTestBatches({
        apiRoot: path.resolve(import.meta.dir, ".."),
        propertyOnly: false,
        testPaths,
      });
      const batches = groups.flatMap(({ testBatches }) => testBatches);
      expect(batches.flat().toSorted()).toEqual(testPaths.toSorted());
      plannedFiles.push(...batches.flat());
      for (const { testBatches, maxPeakRssMb } of groups) {
        for (const batch of testBatches) {
          if (batch.length < 2) {
            continue;
          }
          let sum = 0;
          for (const file of batch) {
            sum += measurements.get(file) ?? DEFAULT_TEST_PEAK_RSS_MB;
          }
          expect(sum).toBeLessThanOrEqual(
            maxPeakRssMb * TEST_BATCH_RSS_HEADROOM_RATIO,
          );
        }
      }
    }
    expect(plannedFiles.toSorted()).toEqual(files.toSorted());
    expect(new Set(plannedFiles).size).toBe(files.length);
  }
});

test("unmeasured files consume a default memory weight", () => {
  expect(
    splitMemoryBoundedBatches({
      batches: [["measured", "new"]],
      peakRssMb: { measured: BUDGET_MB - DEFAULT_TEST_PEAK_RSS_MB + 1 },
      budgetMb: BUDGET_MB,
    }),
  ).toEqual([["measured"], ["new"]]);
  expect(
    splitMemoryBoundedBatches({
      batches: [["a", "b", "c"]],
      peakRssMb: {},
      budgetMb: DEFAULT_TEST_PEAK_RSS_MB * 2,
    }),
  ).toEqual([["a", "b"], ["c"]]);
});

test("memory splitting preserves every file exactly once across shards and bounds shared batches", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.option(fc.integer({ min: 1, max: 3000 }), { nil: undefined }),
        {
          maxLength: 100,
        },
      ),
      fc.integer({ min: 1, max: 8 }),
      (weights, count) => {
        const files = weights.map((_, index) => `file-${index}`);
        const measurements: Record<string, number> = {};
        for (const [index, weight] of weights.entries()) {
          if (weight !== undefined) {
            measurements[`file-${index}`] = weight;
          }
        }
        const shards = partitionTestFiles({ files, durations: {}, count });
        const batches = shards.flatMap((shard) => {
          const original = composeTestBatches(shard, 3);
          const split = splitMemoryBoundedBatches({
            batches: original,
            peakRssMb: measurements,
            budgetMb: BUDGET_MB,
          });
          expect(split.flat()).toEqual(shard);
          for (const batch of split) {
            expect(
              original.some((source) =>
                batch.every((file) => source.includes(file)),
              ),
            ).toBe(true);
            if (batch.length < 2) {
              continue;
            }
            let sum = 0;
            for (const file of batch) {
              sum += measurements[file] ?? DEFAULT_TEST_PEAK_RSS_MB;
            }
            expect(sum).toBeLessThanOrEqual(BUDGET_MB);
          }
          return split;
        });
        expect(batches.flat().toSorted()).toEqual(files.toSorted());
        expect(new Set(batches.flat()).size).toBe(files.length);
      },
    ),
    propertyConfig(),
  );
});

test("invalid memory estimates fail before composition", () => {
  for (const budgetMb of [0, -1, Infinity, Number.NaN]) {
    expect(() =>
      splitMemoryBoundedBatches({ batches: [], peakRssMb: {}, budgetMb }),
    ).toThrow("memory budget must be positive and finite");
  }
  for (const weight of [0, -1, Infinity, Number.NaN]) {
    expect(() =>
      splitMemoryBoundedBatches({
        batches: [["bad"]],
        peakRssMb: { bad: weight },
        budgetMb: BUDGET_MB,
      }),
    ).toThrow("Invalid peak RSS for bad");
  }
});
