import { Result } from "better-result";
import { readFileSync } from "node:fs";

import { spawnPostgresTestProcess } from "./postgres-lock-diagnostics";
import {
  assertSharedTableDdlIsolated,
  EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
} from "./postgres-test-plan";
import {
  planPostgresTestShards,
  selectPostgresTestShard,
} from "./postgres-test-shards";
import { runGatedTests } from "./run-gated-tests";
import { parseApiTestShard } from "./test-file-shards";
import { durationSeconds } from "./test-timings";

const shardValue = process.env["CI_POSTGRES_TEST_SHARD"];
const durationPath = process.env["POSTGRES_TEST_DURATIONS_FILE"];
const measured = durationPath
  ? Result.try(() =>
      durationSeconds(JSON.parse(readFileSync(durationPath, "utf-8"))),
    )
  : undefined;
if (measured === undefined || measured.isErr()) {
  console.log(
    "::notice::Postgres duration cache unavailable; using conservative estimates",
  );
}
const durations = measured?.unwrapOr({}) ?? {};

process.exitCode = await runGatedTests({
  requiredEnv: ["DATABASE_URL"],
  script: "test:postgres",
  selection: process.env["CI_POSTGRES_TEST_SELECTION"],
  exclusiveTestPaths: EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
  spawnTestProcess: spawnPostgresTestProcess,
  validateTestPlan: async (apiRoot, files) => {
    await assertSharedTableDdlIsolated(apiRoot, files);
    const shard = parseApiTestShard(shardValue);
    if (shard !== null) {
      planPostgresTestShards({ files, durations, count: shard.count });
    }
  },
  shardTestFiles: shardValue
    ? (files) => selectPostgresTestShard({ files, durations, shardValue })
    : undefined,
});
