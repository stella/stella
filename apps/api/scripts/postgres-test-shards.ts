import { panic } from "better-result";

import {
  parseApiTestShard,
  planPostgresShardCount,
  planPostgresTestShards,
  POSTGRES_MAX_SHARDS,
  POSTGRES_MIN_SHARDS,
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  POSTGRES_UNKNOWN_TEST_SECONDS,
  postgresShardBudgetWarnings,
  postgresShardMatrix,
  readPostgresTestDurations,
} from "../../../scripts/test-shard-planning";

export {
  POSTGRES_MAX_SHARDS,
  POSTGRES_MIN_SHARDS,
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  POSTGRES_UNKNOWN_TEST_SECONDS,
  planPostgresShardCount,
  planPostgresTestShards,
  postgresShardBudgetWarnings,
  postgresShardMatrix,
  readPostgresTestDurations,
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
