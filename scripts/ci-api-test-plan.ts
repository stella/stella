import { panic } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  allApiTests,
  selectApiTestImpact,
  type ApiTestImpact,
} from "./api-test-impact";

const ImpactSchema = v.strictObject({
  mode: v.picklist(["all", "selected", "none"]),
  files: v.array(
    v.pipe(
      v.string(),
      v.regex(/^(?:src|scripts|evals)\/[^\r\n]*\.test\.tsx?$/u),
    ),
  ),
  shards: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4)),
});

// This also guards the workflow boundary if a selector exits successfully
// with malformed output. A broken selector must never publish an empty matrix.
export const parseApiTestImpact = (output: string): ApiTestImpact => {
  try {
    const impact = v.parse(ImpactSchema, JSON.parse(output));
    if (
      (impact.mode === "all" &&
        (impact.shards !== 4 || impact.files.length !== 0)) ||
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

type CiApiTestPlanOptions = {
  event: string;
  scopeUnknown: boolean;
  apiInScope: boolean;
  select: () => ApiTestImpact;
};
export const planCiApiTests = ({
  event,
  scopeUnknown,
  apiInScope,
  select,
}: CiApiTestPlanOptions) => {
  let impact = allApiTests();
  if (event === "pull_request" && !scopeUnknown) {
    try {
      impact = apiInScope
        ? parseApiTestImpact(JSON.stringify(select()))
        : { mode: "none", files: [], shards: 0 };
    } catch {
      impact = allApiTests();
    }
  }
  return {
    impact,
    matrix: {
      shard: [
        ...Array.from(
          { length: impact.shards },
          (_, index) => `api-${index + 1}`,
        ),
        "rest-web",
      ],
    },
  };
};

const apiInTestScope = (base: string) => {
  const scope = Bun.spawnSync(
    ["bun", "scripts/test-scope.ts", "--base", base],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (scope.exitCode !== 0) {
    panic("Cannot compute test scope");
  }
  const plan = Bun.spawnSync(
    [
      "bun",
      "run",
      "test",
      "--",
      "--dry=json",
      ...scope.stdout.toString().trim().split(/\s+/u),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (plan.exitCode !== 0) {
    panic("Cannot compute Turbo test plan");
  }
  const json: unknown = JSON.parse(plan.stdout.toString());
  const parsed = v.parse(
    v.object({ tasks: v.array(v.object({ taskId: v.string() })) }),
    json,
  );
  return parsed.tasks.some(({ taskId }) => taskId === "@stll/api#test");
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  let plan;
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
    const apiInScope =
      event === "pull_request" && !scopeUnknown
        ? apiInTestScope(`origin/${process.env["BASE_REF"] ?? "main"}`)
        : true;
    plan = planCiApiTests({
      event,
      scopeUnknown,
      apiInScope,
      select: () => selectApiTestImpact({ changed, root }),
    });
  } catch (error) {
    console.error("API test planning failed; using the full suite", error);
    plan = planCiApiTests({
      event: "fallback",
      scopeUnknown: true,
      apiInScope: true,
      select: allApiTests,
    });
  }
  appendFileSync(
    process.env["GITHUB_OUTPUT"] ?? panic("Missing GITHUB_OUTPUT"),
    `ci_tests_matrix=${JSON.stringify(plan.matrix)}\napi_test_shards=${plan.impact.shards}\napi_test_files<<API_TEST_FILES_END\n${plan.impact.files.join("\n")}\nAPI_TEST_FILES_END\n`,
  );
}
