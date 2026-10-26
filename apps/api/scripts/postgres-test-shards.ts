import { panic } from "better-result";

import {
  planPostgresShardCount as planPostgresShardCountResult,
  planPostgresTestShards as planPostgresTestShardsResult,
  POSTGRES_MAX_SHARDS,
  POSTGRES_MIN_SHARDS,
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  POSTGRES_UNKNOWN_TEST_SECONDS,
  postgresShardBudgetWarnings,
  postgresShardMatrix,
  type TestShardPlanningResult,
} from "@stll/scripts/src/test-shard-planning";

import { parseApiTestShard } from "./test-file-shards";

export {
  POSTGRES_MAX_SHARDS,
  POSTGRES_MIN_SHARDS,
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  POSTGRES_UNKNOWN_TEST_SECONDS,
  postgresShardBudgetWarnings,
  postgresShardMatrix,
};

const unwrapPlanningResult = <T>(result: TestShardPlanningResult<T>): T =>
  result.status === "ok" ? result.value : panic(result.message);

export const planPostgresShardCount = (options: {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  budgetSeconds?: number;
  minShards?: number;
  maxShards?: number;
}) => unwrapPlanningResult(planPostgresShardCountResult(options));

export const planPostgresTestShards = (options: {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  count: number;
}) => unwrapPlanningResult(planPostgresTestShardsResult(options));

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
