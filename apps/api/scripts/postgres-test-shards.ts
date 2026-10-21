import { Result, panic } from "better-result";
import { readFileSync } from "node:fs";

import { partitionTestFiles, parseApiTestShard } from "./test-file-shards";
import { durationSeconds } from "./test-timings";

// Each hosted runner is a slot in a shared job pool. ci-plan sizes the shard
// count from measured durations so every shard projects inside the test
// budget, which reserves the rest of the job timeout for setup, migrations
// and diagnostics. Growth adds a shard; it never fails a run.
export const POSTGRES_SHARD_TEST_BUDGET_SECONDS = 480;
export const POSTGRES_MIN_SHARDS = 2;
export const POSTGRES_MAX_SHARDS = 8;
export const POSTGRES_UNKNOWN_TEST_SECONDS = 5;

type PostgresShardPlan = { files: string[]; seconds: number }[];

type PlanPostgresTestShardsOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  count: number;
};

export const planPostgresTestShards = ({
  files,
  durations,
  count,
}: PlanPostgresTestShardsOptions): PostgresShardPlan => {
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
    (shardFiles) => ({
      files: shardFiles,
      seconds: shardFiles.reduce(
        (sum, file) =>
          sum + (weights[file] ?? panic(`Missing duration: ${file}`)),
        0,
      ),
    }),
  );
};

/** Projections above the budget, as warning annotations; never a failure. */
export const postgresShardBudgetWarnings = (
  plan: PostgresShardPlan,
  budgetSeconds = POSTGRES_SHARD_TEST_BUDGET_SECONDS,
) =>
  plan.flatMap(({ files, seconds }, index) =>
    seconds > budgetSeconds
      ? [
          `Postgres shard ${index + 1}/${plan.length} projects ${seconds.toFixed(1)}s over the ${budgetSeconds}s test budget (${files.length} files)`,
        ]
      : [],
  );

type PlanPostgresShardCountOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  budgetSeconds?: number;
  minShards?: number;
  maxShards?: number;
};

/**
 * The fewest shards, between the bounds, whose projections fit the budget.
 * A shard holding one file cannot shrink, so it stops the search instead of
 * adding runners; projections still over the budget at the maximum are
 * returned as warnings, never as a failure.
 */
export const planPostgresShardCount = ({
  files,
  durations,
  budgetSeconds = POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  minShards = POSTGRES_MIN_SHARDS,
  maxShards = POSTGRES_MAX_SHARDS,
}: PlanPostgresShardCountOptions) => {
  if (
    !Number.isSafeInteger(minShards) ||
    !Number.isSafeInteger(maxShards) ||
    minShards < 1 ||
    maxShards < minShards
  ) {
    panic("Postgres shard bounds must satisfy 1 <= min <= max");
  }
  const total = planPostgresTestShards({ files, durations, count: 1 }).reduce(
    (sum, { seconds }) => sum + seconds,
    0,
  );
  const lowerBound = Math.min(
    maxShards,
    Math.max(minShards, Math.ceil(total / budgetSeconds)),
  );
  let plan = planPostgresTestShards({ files, durations, count: lowerBound });
  for (let count = lowerBound; count < maxShards; count += 1) {
    const reducible = plan.some(
      ({ files: shardFiles, seconds }) =>
        seconds > budgetSeconds && shardFiles.length > 1,
    );
    if (!reducible) {
      break;
    }
    plan = planPostgresTestShards({ files, durations, count: count + 1 });
  }
  return {
    count: plan.length,
    plan,
    warnings: postgresShardBudgetWarnings(plan, budgetSeconds),
  };
};

/** Matrix values `i/n`: every shard job name records its run's own n. */
export const postgresShardMatrix = (count: number) =>
  Array.from({ length: count }, (_, index) => `${index + 1}/${count}`);

/** Cached main measurements are optional; a missing cache uses estimates. */
export const readPostgresTestDurations = (
  durationPath: string | undefined,
): Readonly<Record<string, number>> => {
  const measured = durationPath
    ? Result.try(() =>
        durationSeconds(JSON.parse(readFileSync(durationPath, "utf-8"))),
      )
    : undefined;
  if (measured === undefined || measured.isErr()) {
    console.log(
      "::notice::Postgres duration cache unavailable; using conservative estimates",
    );
    return {};
  }
  return measured.value;
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
  for (const warning of postgresShardBudgetWarnings(plan)) {
    console.log(`::warning::${warning}`);
  }
  return plan.at(shard.index - 1)?.files ?? panic("Missing Postgres shard");
};
