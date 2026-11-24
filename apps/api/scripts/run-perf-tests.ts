import { runGatedTests } from "./run-gated-tests";

const SHARD_1_ONLY_FILES = new Set([
  "src/tests/query-perf/redaction-tombstones.test.ts",
]);
const SHARED_SHARDED_FILE = "src/tests/query-perf/query-perf.test.ts";

const rawShard = process.env["QUERY_PERF_SHARD"]?.trim();
if (
  rawShard !== undefined &&
  rawShard !== "" &&
  rawShard !== "1" &&
  rawShard !== "2"
) {
  console.error(`Invalid QUERY_PERF_SHARD=${rawShard}; expected "1" or "2".`);
  process.exitCode = 1;
} else {
  const shard = rawShard === "1" || rawShard === "2" ? rawShard : undefined;
  process.exitCode = await runGatedTests({
    requiredEnv: ["DATABASE_URL"],
    script: "test:perf",
    ...(shard === undefined
      ? {}
      : {
          shardTestFiles: (testFiles) =>
            testFiles.filter((file) => {
              if (file === SHARED_SHARDED_FILE) {
                return true;
              }
              return shard === "1"
                ? SHARD_1_ONLY_FILES.has(file)
                : !SHARD_1_ONLY_FILES.has(file);
            }),
        }),
  });
}
