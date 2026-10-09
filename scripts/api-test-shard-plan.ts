export const API_TEST_SHARD_IDS = ["api-1", "api-2", "api-3", "api-4"] as const;

export const FULL_TEST_JOB_SHARDS = [...API_TEST_SHARD_IDS, "rest-web"];

export const isApiTestShardId = (
  value: string,
): value is (typeof API_TEST_SHARD_IDS)[number] =>
  API_TEST_SHARD_IDS.some((shard) => shard === value);

export const fullTestPlan = () => ({
  matrix: { shard: FULL_TEST_JOB_SHARDS },
  apiShardCount: API_TEST_SHARD_IDS.length,
});

if (import.meta.main) {
  const plan = fullTestPlan();
  process.stdout.write(
    `ci_tests_matrix=${JSON.stringify(plan.matrix)}\napi_test_shards=${plan.apiShardCount}\n`,
  );
}
