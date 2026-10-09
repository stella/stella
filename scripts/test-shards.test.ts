import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import {
  parseApiTestShard,
  partitionTestFiles,
} from "../apps/api/scripts/test-file-shards";
import { allApiTests } from "./api-test-impact";
import {
  API_TEST_SHARD_IDS,
  FULL_TEST_JOB_SHARDS,
  fullTestPlan,
} from "./api-test-shard-plan";
import { planCiApiTests } from "./ci-api-test-plan";
import {
  apiShardValue,
  assertApiShardExecuted,
  shardFilters,
  shardPackages,
  TEST_JOB_SHARDS,
  TEST_SHARD_IDS,
  TEST_SHARD_PACKAGES,
  workspacePackages,
} from "./test-shards.ts";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const workflow = Bun.YAML.parse(
  readFileSync(
    path.join(import.meta.dirname, "../.github/workflows/ci.yml"),
    "utf-8",
  ),
);
const ciTestsSteps = workflowJobSteps(workflow, "ci-tests");

const packages = workspacePackages();
const testedPackages = packages
  .filter(({ hasTestScript }) => hasTestScript)
  .map(({ name }) => name);
const packageNames = packages.map(({ name }) => name);

test("exactly one shard is the complement", () => {
  const complements = TEST_SHARD_IDS.filter(
    (shard) => TEST_SHARD_PACKAGES[shard] === null,
  );
  expect(complements).toHaveLength(1);
});

test("every named shard package is a workspace package that has tests", () => {
  for (const shard of TEST_SHARD_IDS) {
    for (const name of TEST_SHARD_PACKAGES[shard] ?? []) {
      expect(testedPackages).toContain(name);
    }
  }
});

test("the shard families partition every package that has a test script", () => {
  const seen = new Map<string, string>();
  for (const shard of TEST_SHARD_IDS.filter(
    (id) => apiShardValue(id) === "" || apiShardValue(id).startsWith("1/"),
  )) {
    for (const name of shardPackages({ packageNames, shard })) {
      const owner = seen.get(name);
      if (owner !== undefined) {
        throw new Error(`${name} is owned by both ${owner} and ${shard}`);
      }
      seen.set(name, shard);
    }
  }
  expect([...seen.keys()].toSorted()).toEqual(packageNames.toSorted());
});

test("a shard's filters exclude every package it does not own", () => {
  for (const shard of TEST_SHARD_IDS) {
    const owned = new Set(shardPackages({ packageNames, shard }));
    const excluded = new Set(
      shardFilters({ packageNames, shard }).map((filter) =>
        filter.replace("--filter=!", ""),
      ),
    );
    for (const name of testedPackages) {
      expect(owned.has(name)).toBe(!excluded.has(name));
    }
  }
});

// The workflow matrix is the other half of the shard map: a shard the matrix
// omits runs nowhere, and its packages would leave CI silently.
test("the ci-tests matrix runs exactly the declared jobs", () => {
  expect(workflow).toMatchObject({
    jobs: {
      "ci-tests": {
        strategy: {
          matrix: `\${{ fromJSON(needs.ci-plan.outputs.ci_tests_matrix) }}`,
        },
      },
    },
  });
  const declared = planCiApiTests({
    event: "merge_group",
    scopeUnknown: false,
    apiInScope: true,
    select: allApiTests,
  }).matrix.shard;
  expect(declared).toEqual(Object.keys(TEST_JOB_SHARDS));
  expect(declared).toEqual(FULL_TEST_JOB_SHARDS);
});

test("merged jobs run every suite exactly once and preserve the package partition", () => {
  const suites = Object.values(TEST_JOB_SHARDS).flat();
  expect(suites.toSorted()).toEqual([...TEST_SHARD_IDS].toSorted());
  const merged = TEST_JOB_SHARDS["rest-web"].flatMap((shard) =>
    shardPackages({ packageNames, shard }),
  );
  expect(new Set(merged).size).toBe(merged.length);
  expect(merged.toSorted()).toEqual(
    packageNames.filter((name) => name !== "@stll/api").toSorted(),
  );
});

test("both suites in the merged leg report a verdict after an earlier failure", () => {
  for (const name of ["Test API or rest", "Test web", "Test .claude/mcp"]) {
    const step = workflowStepByName(ciTestsSteps, name);
    expect(step["if"]).toContain("!cancelled()");
    expect(step["if"]).toContain(
      "needs.ci-plan.outputs.package_checks_required == 'true'",
    );
  }
  expect(
    workflowStepByName(ciTestsSteps, "Test API or rest")["env"],
  ).toMatchObject({
    SHARD: `\${{ matrix.shard == 'rest-web' && 'rest' || matrix.shard }}`,
  });
  expect(workflowStepByName(ciTestsSteps, "Test web")["env"]).toMatchObject({
    SHARD: "web",
  });
});

test("exactly one shard runs the .claude/mcp suite", () => {
  const invocations = ciTestsSteps.flatMap((step) =>
    typeof step["run"] === "string"
      ? [...step["run"].matchAll(/bun --cwd \.claude\/mcp test/gu)]
      : [],
  );
  expect(invocations).toHaveLength(1);
  const step = workflowStepByName(ciTestsSteps, "Test .claude/mcp");
  expect(step["run"]).toContain("bun --cwd .claude/mcp test");
  const gate = /matrix\.shard == '(?<shard>[a-z-]+)'/u.exec(
    typeof step["if"] === "string" ? step["if"] : "",
  )?.groups?.["shard"];
  if (gate === undefined) {
    throw new Error("the .claude/mcp step is not gated on a shard");
  }
  const shardIds = Object.keys(TEST_JOB_SHARDS);
  expect(shardIds).toContain(gate);
});

test("API sub-shards cover every discovered file exactly once, including new files", () => {
  const files = listApiTestPaths(
    path.resolve(import.meta.dirname, "../apps/api"),
  );
  const newFile = "src/new-shard-census.test.ts";
  expect(files).not.toContain(newFile);
  const input = [...files, newFile];
  const selected = fullTestPlan().matrix.shard.flatMap((job) => {
    const id = API_TEST_SHARD_IDS.find((shard) => shard === job);
    if (id === undefined) {
      return [];
    }
    const shard = parseApiTestShard(apiShardValue(id));
    return shard === null
      ? []
      : (partitionTestFiles({
          files: input,
          durations: {},
          count: shard.count,
        }).at(shard.index - 1) ?? []);
  });
  expect(selected.toSorted()).toEqual(input.toSorted());
  expect(new Set(selected).size).toBe(input.length);
});

const FULL_API_SUITE_EXEMPTIONS = {
  ".github/workflows/api-test-memory.yml/measure/Measure every test in this shard":
    "The memory profiler uses a dedicated numeric matrix to measure every API file serially.",
} as const;

const WorkflowCensusSchema = v.object({
  jobs: v.record(
    v.string(),
    v.object({
      steps: v.optional(
        v.array(
          v.object({
            env: v.optional(v.record(v.string(), v.unknown()), {}),
            name: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
        [],
      ),
    }),
  ),
});

test("every workflow running the full API suite uses the shared shard plan or has a reason", () => {
  const workflowsDirectory = path.resolve(
    import.meta.dirname,
    "../.github/workflows",
  );
  const unshared: string[] = [];
  for (const filename of readdirSync(workflowsDirectory).filter((name) =>
    name.endsWith(".yml"),
  )) {
    const workflowSource = readFileSync(
      path.join(workflowsDirectory, filename),
      "utf-8",
    );
    const parsed = v.parse(
      WorkflowCensusSchema,
      Bun.YAML.parse(workflowSource),
    );
    for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== "string" || typeof step.name !== "string") {
          continue;
        }
        const runsFullApiSuite =
          (/bun run test --(?:\s|$)/u.test(step.run) &&
            step.env["SHARD"] !== "web") ||
          /bun --filter[= ]@stll\/api test --(?:\s|$)/u.test(step.run);
        if (!runsFullApiSuite) {
          continue;
        }
        const shared =
          step.run.includes("scripts/test-shards.ts --api-shard") &&
          workflowSource.includes("scripts/api-test-shard-plan.ts");
        if (!shared) {
          unshared.push(
            `.github/workflows/${filename}/${jobName}/${step.name}`,
          );
        }
      }
    }
  }
  expect(unshared.toSorted()).toEqual(
    Object.keys(FULL_API_SUITE_EXEMPTIONS).toSorted(),
  );
  for (const reason of Object.values(FULL_API_SUITE_EXEMPTIONS)) {
    expect(reason.length).toBeGreaterThan(0);
  }
});

test("an in-scope API leg rejects help, empty or another shard's output", () => {
  const taskIds = ["@stll/api#test"];
  for (const output of [
    "",
    "Usage: bun run [flags] <script>",
    "API test shard 1/4: 0/10 files",
    "API test shard 2/4: 5/10 files",
  ]) {
    expect(() =>
      assertApiShardExecuted({ shard: "api-1", taskIds, output }),
    ).toThrow("ran no API test files");
  }
  assertApiShardExecuted({
    shard: "api-1",
    taskIds,
    output: "@stll/api:test: API test shard 1/4: 5/10 files",
  });
  assertApiShardExecuted({ shard: "api-1", taskIds: [], output: "" });
  assertApiShardExecuted({ shard: "rest", taskIds, output: "" });
});

test("dynamic API shard counts certify the selected partition and allow zero API work in rest", () => {
  expect(apiShardValue("rest", 0)).toBe("");
  expect(apiShardValue("web", 0)).toBe("");
  assertApiShardExecuted({
    shard: "rest",
    count: 0,
    taskIds: ["@stll/scripts#test"],
    output: "",
  });
  for (const count of [1, 2, 3, 4]) {
    for (const [index, shard] of (
      ["api-1", "api-2", "api-3", "api-4"] as const
    ).entries()) {
      if (index >= count) {
        expect(() => apiShardValue(shard, count)).toThrow(
          "outside the planned shard count",
        );
        continue;
      }
      const value = `${index + 1}/${count}`;
      expect(apiShardValue(shard, count)).toBe(value);
      assertApiShardExecuted({
        shard,
        count,
        taskIds: ["@stll/api#test"],
        output: `API test shard ${value}: 1/2 files`,
      });
      expect(() =>
        assertApiShardExecuted({
          shard,
          count,
          taskIds: ["@stll/api#test"],
          output: "API test shard 1/9: 1/2 files",
        }),
      ).toThrow("ran no API test files");
    }
  }
});
