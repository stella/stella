import { expect, test } from "bun:test";
import fc from "fast-check";

import { parseApiTestShard, partitionTestFiles } from "./test-file-shards";

test("partitions are complete, deterministic and bounded for every measured workload", () => {
  fc.assert(
    fc.property(
      fc.array(fc.nat({ max: 10_000 }), { maxLength: 100 }),
      fc.integer({ min: 1, max: 12 }),
      (weights, count) => {
        const files = weights.map((_, index) => `file-${index}.test.ts`);
        const durations = Object.fromEntries(
          files.map((file, index) => [file, weights[index] ?? 0]),
        );
        const bins = partitionTestFiles({ files, durations, count });
        expect(bins.flat().toSorted()).toEqual(files.toSorted());
        expect(new Set(bins.flat()).size).toBe(files.length);
        expect(partitionTestFiles({ files, durations, count })).toEqual(bins);
        expect(
          partitionTestFiles({
            files: files.toReversed(),
            durations,
            count,
          }).map((bin) => bin.toSorted()),
        ).toEqual(bins.map((bin) => bin.toSorted()));
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        const longest = Math.max(0, ...weights);
        for (const bin of bins) {
          expect(
            bin.reduce((sum, file) => sum + (durations[file] ?? 0), 0),
          ).toBeLessThanOrEqual(total / count + longest);
        }
        expect(partitionTestFiles({ files, durations, count: 1 })).toEqual([
          files,
        ]);
      },
    ),
  );
});

test("new files use the live median and stale measurements cannot change assignment", () => {
  const files = ["a", "b", "new"];
  const durations = { a: 2, b: 2 };
  const bins = partitionTestFiles({ files, durations, count: 2 });
  expect(bins.flat().toSorted()).toEqual(files.toSorted());
  expect(bins.map((bin) => bin.length).toSorted()).toEqual([1, 2]);
  expect(
    partitionTestFiles({
      files,
      durations: { ...durations, deleted: 10_000 },
      count: 2,
    }),
  ).toEqual(bins);
  expect(
    partitionTestFiles({ files, durations: {}, count: 4 }).flat().toSorted(),
  ).toEqual(files.toSorted());
});

test("invalid shard configuration and measurements fail before any tests run", () => {
  for (const value of [
    "0/4",
    "5/4",
    "1/0",
    "one/four",
    "1/2/3",
    "9007199254740992/9007199254740992",
  ]) {
    expect(() => parseApiTestShard(value)).toThrow("Invalid API_TEST_SHARD");
  }
  expect(parseApiTestShard(undefined)).toBeNull();
  expect(parseApiTestShard("")).toBeNull();
  expect(parseApiTestShard("2/4")).toEqual({ index: 2, count: 4 });
  for (const count of [0, -1, 1.5, Infinity]) {
    expect(() =>
      partitionTestFiles({ files: [], durations: {}, count }),
    ).toThrow("positive integer");
  }
  expect(() =>
    partitionTestFiles({ files: ["a", "a"], durations: {}, count: 2 }),
  ).toThrow("unique");
  for (const duration of [-1, Infinity, Number.NaN]) {
    expect(() =>
      partitionTestFiles({
        files: ["a"],
        durations: { a: duration },
        count: 2,
      }),
    ).toThrow("Invalid duration");
  }
});
