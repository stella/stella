import { expect, test } from "bun:test";

import {
  parseApiTestShard,
  partitionTestFiles,
  planPostgresShardCount,
  planPostgresTestShards,
  readTestDurationWeights,
  testFileDurationWeights,
} from "./test-shard-planning";

test("shared shard planning assigns measured and new files deterministically", () => {
  const files = ["z.test.ts", "a.test.ts", "b.test.ts"];
  const durations = { "a.test.ts": 4, "b.test.ts": 4 };
  const result = partitionTestFiles({ files, durations, count: 2 });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    return;
  }
  const plan = result.value;

  expect(plan).toEqual([["a.test.ts", "z.test.ts"], ["b.test.ts"]]);
  expect(plan.flat().toSorted()).toEqual(files.toSorted());
  expect(
    partitionTestFiles({ files: files.toReversed(), durations, count: 2 }),
  ).toEqual({
    status: "ok",
    value: plan,
  });
});

test("shared planners report invalid inputs without throwing", () => {
  expect(partitionTestFiles({ files: [], durations: {}, count: 0 })).toEqual({
    status: "invalid",
    message: "Test shard count must be a positive integer",
  });
  expect(
    partitionTestFiles({ files: ["a", "a"], durations: {}, count: 2 }),
  ).toEqual({ status: "invalid", message: "Test paths must be unique" });
  expect(testFileDurationWeights(["a"], { a: Number.NaN })).toEqual({
    status: "invalid",
    message: "Invalid duration for a",
  });
  expect(readTestDurationWeights(null)).toEqual({
    status: "invalid",
    message: "Invalid test duration weights",
  });
  expect(parseApiTestShard("2/1")).toEqual({
    status: "invalid",
    message: "Invalid API_TEST_SHARD: expected i/n with 1 <= i <= n",
  });
  expect(
    planPostgresTestShards({ files: ["a"], durations: { a: -1 }, count: 1 }),
  ).toEqual({
    status: "invalid",
    message: "Invalid Postgres test duration: a",
  });
  expect(
    planPostgresShardCount({
      files: ["a"],
      durations: {},
      minShards: 3,
      maxShards: 2,
    }),
  ).toEqual({
    status: "invalid",
    message: "Postgres shard bounds must satisfy 1 <= min <= max",
  });
});
