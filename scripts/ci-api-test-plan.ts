import { panic } from "better-result";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  allApiTests,
  type ApiTestImpact,
  selectApiTestImpact,
} from "./api-test-impact";
import {
  API_TEST_SHARD_IDS,
  FULL_TEST_JOB_SHARDS,
  fullTestPlan,
  isApiTestShardId,
} from "./api-test-shard-plan";
import { selectedTestJobs } from "./ci-affected-selection";

const ImpactSchema = v.strictObject({
  mode: v.picklist(["all", "selected", "none"]),
  files: v.array(
    v.pipe(
      v.string(),
      v.regex(/^(?:src|scripts|evals)\/[^\r\n]*\.test\.tsx?$/u),
    ),
  ),
  shards: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(API_TEST_SHARD_IDS.length),
  ),
});

// This also guards the workflow boundary if a selector exits successfully
// with malformed output. A broken selector must never publish an empty matrix.
export const parseApiTestImpact = (output: string): ApiTestImpact => {
  try {
    const impact = v.parse(ImpactSchema, JSON.parse(output));
    if (
      (impact.mode === "all" &&
        (impact.shards !== API_TEST_SHARD_IDS.length ||
          impact.files.length !== 0)) ||
      (impact.mode === "none" &&
        (impact.shards !== 0 || impact.files.length !== 0)) ||
      (impact.mode === "selected" &&
        (impact.shards < 1 ||
          impact.files.length < impact.shards ||
          new Set(impact.files).size !== impact.files.length ||
          impact.files.some((file) => file.split("/").includes(".."))))
    ) {
      return allApiTests();
    }
    return impact;
  } catch {
    return allApiTests();
  }
};

type TestJobShard = (typeof FULL_TEST_JOB_SHARDS)[number];
type NonEmptyTestJobShards = readonly [TestJobShard, ...TestJobShard[]];
type CiApiTestPlan =
  | {
      type: "run";
      impact: ApiTestImpact;
      matrix: { shard: NonEmptyTestJobShards };
    }
  | { type: "skip"; impact: ApiTestImpact };
type CiApiTestPlanOptions = {
  event: string;
  scopeUnknown: boolean;
  testJobs: readonly TestJobShard[];
  select: () => ApiTestImpact;
};
export const planCiApiTests = ({
  event,
  scopeUnknown,
  testJobs,
  select,
}: CiApiTestPlanOptions): CiApiTestPlan => {
  let impact = allApiTests();
  if ((event === "pull_request" || event === "merge_group") && !scopeUnknown) {
    try {
      if (!testJobs.some(isApiTestShardId)) {
        impact = { mode: "none", files: [], shards: 0 };
      } else if (event === "pull_request") {
        impact = parseApiTestImpact(JSON.stringify(select()));
      }
    } catch {
      impact = allApiTests();
    }
  }
  const fullPlan = fullTestPlan();
  const enabledApiShards = new Set(API_TEST_SHARD_IDS.slice(0, impact.shards));
  const shards = fullPlan.matrix.shard.filter(
    (shard) =>
      (scopeUnknown ||
        !["pull_request", "merge_group"].includes(event) ||
        testJobs.includes(shard)) &&
      (!isApiTestShardId(shard) || enabledApiShards.has(shard)),
  );
  const firstShard = shards.at(0);
  if (firstShard === undefined) {
    return { type: "skip", impact };
  }
  return {
    type: "run",
    impact,
    matrix: { shard: [firstShard, ...shards.slice(1)] },
  };
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  let plan;
  let testScope = "";
  try {
    const event = process.env["EVENT_NAME"] ?? "";
    const scopeUnknown = process.env["API_SCOPE_UNKNOWN"] === "true";
    const changed = readFileSync(
      path.join(
        process.env["RUNNER_TEMP"] ?? panic("Missing RUNNER_TEMP"),
        "api-test-changed-paths",
      ),
      "utf-8",
    )
      .split("\0")
      .filter(Boolean);
    let testJobs = FULL_TEST_JOB_SHARDS;
    if (!scopeUnknown && ["pull_request", "merge_group"].includes(event)) {
      const comparisonBase =
        process.env["COMPARISON_BASE"] ?? panic("Missing COMPARISON_BASE");
      const scopeResult = Bun.spawnSync(
        ["bun", "scripts/test-scope.ts", "--base", comparisonBase],
        { cwd: root, stderr: "pipe", stdout: "pipe" },
      );
      if (scopeResult.exitCode !== 0) {
        panic(`Test scope failed: ${scopeResult.stderr.toString()}`);
      }
      testScope = scopeResult.stdout.toString().trim();
      const scopeArgs = testScope.split(/\s+/u).filter(Boolean);
      const dryRun = Bun.spawnSync(
        [
          "bun",
          "run",
          "test",
          "--",
          "--concurrency=2",
          ...scopeArgs,
          "--dry=json",
        ],
        { cwd: root, stderr: "pipe", stdout: "pipe" },
      );
      if (dryRun.exitCode !== 0) {
        panic(`Test plan failed: ${dryRun.stderr.toString()}`);
      }
      const output = dryRun.stdout.toString();
      const jsonStart = output.indexOf("{");
      if (jsonStart === -1) {
        panic("Test plan did not contain JSON");
      }
      testJobs = selectedTestJobs(output.slice(jsonStart), root);
    }
    plan = planCiApiTests({
      event,
      scopeUnknown,
      testJobs,
      select: () => selectApiTestImpact({ changed, root }),
    });
  } catch (error) {
    console.error("API test planning failed; using the full suite", error);
    plan = planCiApiTests({
      event: "fallback",
      scopeUnknown: true,
      testJobs: FULL_TEST_JOB_SHARDS,
      select: allApiTests,
    });
  }
  const matrix =
    plan.type === "run" ? plan.matrix : { shard: ["rest-web"] as const };
  writeFileSync(
    path.join(
      process.env["RUNNER_TEMP"] ?? panic("Missing RUNNER_TEMP"),
      "api-test-files",
    ),
    plan.impact.files.join("\n"),
  );
  appendFileSync(
    process.env["GITHUB_OUTPUT"] ?? panic("Missing GITHUB_OUTPUT"),
    `ci_tests_required=${plan.type === "run"}\nci_tests_matrix=${JSON.stringify(matrix)}\napi_test_shards=${plan.impact.shards}\ntest_scope=${testScope}\napi_test_files<<API_TEST_FILES_END\n${plan.impact.files.join("\n")}\nAPI_TEST_FILES_END\n`,
  );
}
