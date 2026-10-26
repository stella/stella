import { expect, test } from "bun:test";

import { partitionTestFiles } from "../../../scripts/test-shard-planning";
import {
  planPostgresShardCount,
  planPostgresTestShards,
  POSTGRES_MAX_SHARDS,
  POSTGRES_MIN_SHARDS,
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  POSTGRES_UNKNOWN_TEST_SECONDS,
  postgresShardMatrix,
  selectPostgresTestShard,
} from "./postgres-test-shards";

const budget = POSTGRES_SHARD_TEST_BUDGET_SECONDS;

test("shared shard planning assigns measured and new files deterministically", () => {
  const files = ["z.test.ts", "a.test.ts", "b.test.ts"];
  const durations = { "a.test.ts": 4, "b.test.ts": 4 };
  const plan = partitionTestFiles({ files, durations, count: 2 });

  expect(plan).toEqual([["a.test.ts", "z.test.ts"], ["b.test.ts"]]);
  expect(plan.flat().toSorted()).toEqual(files.toSorted());
  expect(
    partitionTestFiles({ files: files.toReversed(), durations, count: 2 }),
  ).toEqual(plan);
});

const uniformSuite = (fileCount: number, seconds: number) => {
  const files = Array.from(
    { length: fileCount },
    (_, index) => `src/${String(index).padStart(3, "0")}.test.ts`,
  );
  return {
    files,
    durations: Object.fromEntries(files.map((file) => [file, seconds])),
  };
};

test("duration shards cover every selected file once", () => {
  const files = ["a", "b", "c", "d", "e"];
  const durations = { a: 100, b: 70, c: 30, d: 15, e: 10 };
  const shards = planPostgresTestShards({ files, durations, count: 3 });
  expect(shards.flatMap((shard) => shard.files).toSorted()).toEqual(files);
  expect(shards.map((shard) => shard.seconds)).toEqual([100, 70, 55]);
  expect(
    planPostgresTestShards({ files: files.toReversed(), durations, count: 3 }),
  ).toEqual(shards);
});

test("the planner picks the fewest shards whose projections fit the budget", () => {
  // 100 files of 12 s: 1200 s fits three 400 s shards.
  const three = planPostgresShardCount(uniformSuite(100, 12));
  expect(three.count).toBe(3);
  expect(three.plan.map(({ seconds }) => seconds)).toEqual([408, 396, 396]);
  expect(three.warnings).toEqual([]);
  // A small suite still runs on the minimum.
  expect(planPostgresShardCount(uniformSuite(10, 5)).count).toBe(
    POSTGRES_MIN_SHARDS,
  );
  // An empty plan keeps the minimum and never divides by nothing.
  expect(planPostgresShardCount({ files: [], durations: {} }).count).toBe(
    POSTGRES_MIN_SHARDS,
  );
});

test("growth past the budget adds a shard instead of failing", () => {
  const files = ["a", "b", "c"];
  const durations = { a: budget * 0.6, b: budget * 0.6, c: budget * 0.6 };
  // The lower bound ceil(1.8) = 2 still packs two files into one shard.
  expect(
    planPostgresTestShards({ files, durations, count: 2 }).some(
      ({ seconds }) => seconds > budget,
    ),
  ).toBeTrue();
  const grown = planPostgresShardCount({ files, durations });
  expect(grown.count).toBe(3);
  expect(grown.warnings).toEqual([]);
  // One file past n full budgets lifts n by one.
  for (
    let count = POSTGRES_MIN_SHARDS;
    count < POSTGRES_MAX_SHARDS;
    count += 1
  ) {
    const fileCount = count * 8;
    const seconds = budget / 8;
    expect(planPostgresShardCount(uniformSuite(fileCount, seconds)).count).toBe(
      count,
    );
    expect(
      planPostgresShardCount(uniformSuite(fileCount + 1, seconds)).count,
    ).toBe(count + 1);
  }
});

test("projections over budget at the maximum are warnings, not failures", () => {
  const huge = uniformSuite(POSTGRES_MAX_SHARDS * 10, budget / 5);
  const capped = planPostgresShardCount(huge);
  expect(capped.count).toBe(POSTGRES_MAX_SHARDS);
  expect(capped.warnings).toHaveLength(POSTGRES_MAX_SHARDS);
  expect(capped.warnings[0]).toContain(
    `1/${POSTGRES_MAX_SHARDS} projects 960.0s over the ${budget}s test budget`,
  );
  // One oversized file cannot shrink: no runner is added for it.
  const oversized = planPostgresShardCount({
    files: ["a", "b"],
    durations: { a: budget + 1, b: 1 },
  });
  expect(oversized.count).toBe(POSTGRES_MIN_SHARDS);
  expect(oversized.warnings).toHaveLength(1);
  // Shard selection on an over-budget plan still returns its files.
  expect(
    selectPostgresTestShard({
      files: ["a", "b"],
      durations: { a: budget + 1, b: 1 },
      shardValue: "1/2",
    }),
  ).toEqual(["a"]);
});

test("cold caches plan from conservative estimates", () => {
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
  const coldFiles = Array.from(
    { length: Math.floor(budget / POSTGRES_UNKNOWN_TEST_SECONDS) * 3 + 1 },
    (_, i) => String(i),
  );
  expect(
    planPostgresShardCount({ files: coldFiles, durations: {} }).count,
  ).toBe(4);
});

test("matrix values name the shard and the run's own n", () => {
  expect(postgresShardMatrix(3)).toEqual(["1/3", "2/3", "3/3"]);
  // Every value parses as the selector the shard job reads.
  for (const value of postgresShardMatrix(POSTGRES_MAX_SHARDS)) {
    expect(() =>
      selectPostgresTestShard({
        files: ["a"],
        durations: {},
        shardValue: value,
      }),
    ).not.toThrow();
  }
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
  expect(() =>
    planPostgresShardCount({
      files: ["a"],
      durations: {},
      minShards: 3,
      maxShards: 2,
    }),
  ).toThrow("1 <= min <= max");
});
