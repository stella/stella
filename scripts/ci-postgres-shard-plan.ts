import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import apiPackageJson from "../apps/api/package.json" with { type: "json" };
import { discoverGatedTestFiles } from "../apps/api/scripts/gated-test-files";
import {
  parseTestDurationWeights,
  planPostgresShardCount,
  postgresShardMatrix,
  type TestShardPlanningResult,
} from "../packages/scripts/src/test-shard-planning";

type PostgresShardOutputsOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
};

type PostgresShardOutputs = {
  output: string;
  summary: string;
  warnings: string[];
};

const readPostgresTestDurations = (
  durationPath: string | undefined,
): Readonly<Record<string, number>> => {
  if (durationPath === undefined || durationPath === "") {
    console.log(
      "::notice::Postgres duration cache unavailable; using conservative estimates",
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(durationPath, "utf-8"));
  } catch {
    console.log(
      "::notice::Postgres duration cache unreadable; using conservative estimates",
    );
    return {};
  }
  const weights = parseTestDurationWeights(parsed);
  if (weights === undefined) {
    console.log(
      "::notice::Postgres duration cache has an invalid schema; using conservative estimates",
    );
    return {};
  }
  return Object.fromEntries(
    Object.entries(weights).map(([file, { seconds }]) => [file, seconds]),
  );
};

/**
 * Sizes the Postgres service matrix from the full gated suite, the same
 * files every shard partitions, so each run's n follows measured time.
 */
export const postgresShardOutputs = ({
  files,
  durations,
}: PostgresShardOutputsOptions): TestShardPlanningResult<PostgresShardOutputs> => {
  if (files.length === 0) {
    return {
      status: "invalid",
      message: "No Postgres-gated test files discovered",
    };
  }
  const result = planPostgresShardCount({
    files,
    durations,
  });
  if (result.status === "invalid") {
    return result;
  }
  const { count, plan, warnings } = result.value;
  return {
    status: "ok",
    value: {
      output: `postgres_shards=${JSON.stringify(postgresShardMatrix(count))}\npostgres_shard_count=${count}\n`,
      summary: `### Postgres test shards\n\n${count} shards; projected seconds ${JSON.stringify(plan.map(({ seconds }) => Math.round(seconds)))}\n`,
      warnings,
    },
  };
};

if (import.meta.main) {
  const runner = apiPackageJson.ciGateTestRunners["test:postgres"];
  const files = await discoverGatedTestFiles({
    apiRoot: path.resolve(import.meta.dir, "../apps/api"),
    gate: runner.gate,
    testFileGlob: runner.testFileGlob,
  });
  const outputs = postgresShardOutputs({
    files,
    durations: readPostgresTestDurations(
      process.env["POSTGRES_TEST_DURATIONS_FILE"],
    ),
  });
  if (outputs.status === "invalid") {
    console.error(outputs.message);
    process.exitCode = 1;
  } else {
    const { output, summary, warnings } = outputs.value;
    for (const warning of warnings) {
      console.log(`::warning::${warning}`);
    }
    console.log(summary);
    const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
    if (stepSummary) {
      appendFileSync(stepSummary, summary);
    }
    const githubOutput = process.env["GITHUB_OUTPUT"];
    if (githubOutput === undefined || githubOutput === "") {
      console.error("Missing GITHUB_OUTPUT");
      process.exitCode = 1;
    } else {
      appendFileSync(githubOutput, output);
    }
  }
}
