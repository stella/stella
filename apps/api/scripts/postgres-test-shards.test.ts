import { expect, test } from "bun:test";

import {
  planPostgresTestShards,
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  POSTGRES_TEST_SHARD_IDS,
  POSTGRES_UNKNOWN_TEST_SECONDS,
  selectPostgresTestShard,
} from "./postgres-test-shards";

const budget = POSTGRES_SHARD_TEST_BUDGET_SECONDS;
const overBudget = `exceeding ${budget}s test budget`;

test("duration shards cover every selected file once and stay within budget", () => {
  const files = ["a", "b", "c", "d", "e"];
  const durations = { a: 100, b: 70, c: 30, d: 15, e: 10 };
  const shards = planPostgresTestShards({
    files,
    durations,
    count: 3,
    budgetSeconds: 100,
  });
  expect(shards.flatMap((shard) => shard.files).toSorted()).toEqual(files);
  expect(shards.map((shard) => shard.seconds)).toEqual([100, 70, 55]);
  expect(
    planPostgresTestShards({ files: files.toReversed(), durations, count: 3 }),
  ).toEqual(shards);
});

test("a single oversized suite and aggregate growth both fail the budget", () => {
  expect(() =>
    planPostgresTestShards({
      files: ["a"],
      durations: { a: budget + 1 },
      count: POSTGRES_TEST_SHARD_IDS.length,
    }),
  ).toThrow(overBudget);
  expect(() =>
    planPostgresTestShards({
      files: ["a", "b", "c"],
      durations: { a: budget * 0.6, b: budget * 0.6, c: budget * 0.6 },
      count: 2,
    }),
  ).toThrow(overBudget);
});

test("missing durations conservatively use five seconds or the measured median", () => {
  expect(
    planPostgresTestShards({ files: ["a", "b"], durations: {}, count: 1 }),
  ).toEqual([{ files: ["a", "b"], seconds: 10 }]);
  expect(
    planPostgresTestShards({
      files: ["a", "b"],
      durations: { a: 20 },
      count: 1,
    }),
  ).toEqual([{ files: ["a", "b"], seconds: 40 }]);
  expect(() =>
    planPostgresTestShards({
      files: Array.from(
        { length: Math.floor(budget / POSTGRES_UNKNOWN_TEST_SECONDS) + 1 },
        (_, i) => String(i),
      ),
      durations: {},
      count: 1,
    }),
  ).toThrow(overBudget);
});

test("small selections permit empty shards and reject invalid shard input", () => {
  expect(
    selectPostgresTestShard({ files: ["a"], durations: {}, shardValue: "2/3" }),
  ).toEqual([]);
  expect(() =>
    selectPostgresTestShard({ files: ["a"], durations: {}, shardValue: "4/3" }),
  ).toThrow("expected i/n");
  expect(() =>
    planPostgresTestShards({ files: ["a"], durations: { a: -1 }, count: 1 }),
  ).toThrow("Invalid Postgres test duration");
});
