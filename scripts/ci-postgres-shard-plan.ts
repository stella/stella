import { appendFileSync } from "node:fs";
import path from "node:path";

import apiPackageJson from "../apps/api/package.json" with { type: "json" };
import { discoverGatedTestFiles } from "../apps/api/scripts/gated-test-files";
import {
  planPostgresShardCount,
  postgresShardMatrix,
  readPostgresTestDurations,
  TestShardPlanningError,
} from "../packages/scripts/src/test-shard-planning";

const fail = (message: string): never => {
  throw new TestShardPlanningError(message);
};

type PostgresShardOutputsOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
};

/**
 * Sizes the Postgres service matrix from the full gated suite, the same
 * files every shard partitions, so each run's n follows measured time.
 */
export const postgresShardOutputs = ({
  files,
  durations,
}: PostgresShardOutputsOptions) => {
  const { count, plan, warnings } = planPostgresShardCount({
    files,
    durations,
  });
  return {
    output: `postgres_shards=${JSON.stringify(postgresShardMatrix(count))}\npostgres_shard_count=${count}\n`,
    summary: `### Postgres test shards\n\n${count} shards; projected seconds ${JSON.stringify(plan.map(({ seconds }) => Math.round(seconds)))}\n`,
    warnings,
  };
};

if (import.meta.main) {
  const runner = apiPackageJson.ciGateTestRunners["test:postgres"];
  const files = await discoverGatedTestFiles({
    apiRoot: path.resolve(import.meta.dir, "../apps/api"),
    gate: runner.gate,
    testFileGlob: runner.testFileGlob,
  });
  if (files.length === 0) {
    fail("No Postgres-gated test files discovered");
  }
  const { output, summary, warnings } = postgresShardOutputs({
    files,
    durations: readPostgresTestDurations(
      process.env["POSTGRES_TEST_DURATIONS_FILE"],
    ),
  });
  for (const warning of warnings) {
    console.log(`::warning::${warning}`);
  }
  console.log(summary);
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary) {
    appendFileSync(stepSummary, summary);
  }
  appendFileSync(
    process.env["GITHUB_OUTPUT"] ?? fail("Missing GITHUB_OUTPUT"),
    output,
  );
}
