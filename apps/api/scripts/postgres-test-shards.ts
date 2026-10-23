import { panic } from "better-result";

import { parseApiTestShard, partitionTestFiles } from "./test-file-shards";

// Three shards: each hosted runner is a slot in a shared job pool, and the
// suites outgrew two 480 s shards. Three keep every shard inside the budget,
// which reserves the remaining seven minutes for setup, migrations and
// diagnostics.
export const POSTGRES_TEST_SHARD_IDS = [1, 2, 3] as const;
export const POSTGRES_SHARD_TEST_BUDGET_SECONDS = 480;
export const POSTGRES_UNKNOWN_TEST_SECONDS = 5;

type PlanPostgresTestShardsOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  count: number;
  budgetSeconds?: number;
};

export const planPostgresTestShards = ({
  files,
  durations,
  count,
  budgetSeconds = POSTGRES_SHARD_TEST_BUDGET_SECONDS,
}: PlanPostgresTestShardsOptions) => {
  const measured = files
    .flatMap((file) => {
      const seconds = durations[file];
      if (seconds === undefined) {
        return [];
      }
      if (!Number.isFinite(seconds) || seconds < 0) {
        panic(`Invalid Postgres test duration: ${file}`);
      }
      return [seconds];
    })
    .toSorted((a, b) => a - b);
  // A cold cache must retain a useful estimate, rather than one second per file.
  const fallback = Math.max(
    POSTGRES_UNKNOWN_TEST_SECONDS,
    measured.at(Math.floor(measured.length / 2)) ?? 0,
  );
  const weights = Object.fromEntries(
    files.map((file) => [file, durations[file] ?? fallback]),
  );
  return partitionTestFiles({ files, durations: weights, count }).map(
    (shardFiles, index) => {
      const seconds = shardFiles.reduce(
        (sum, file) =>
          sum + (weights[file] ?? panic(`Missing duration: ${file}`)),
        0,
      );
      if (seconds > budgetSeconds) {
        panic(
          `Postgres shard ${index + 1}/${count} projects ${seconds.toFixed(1)}s, exceeding ${budgetSeconds}s test budget`,
        );
      }
      return { files: shardFiles, seconds };
    },
  );
};

type SelectPostgresTestShardOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  shardValue: string;
};

export const selectPostgresTestShard = ({
  files,
  durations,
  shardValue,
}: SelectPostgresTestShardOptions) => {
  const shard = parseApiTestShard(shardValue);
  if (shard === null) {
    panic("Postgres test shard must be i/n");
  }
  const plan = planPostgresTestShards({ files, durations, count: shard.count });
  console.log(
    `Postgres shard projections: ${JSON.stringify(plan.map(({ seconds }) => seconds))}`,
  );
  return plan.at(shard.index - 1)?.files ?? panic("Missing Postgres shard");
};
