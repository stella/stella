import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import durations from "../apps/api/scripts/test-durations.json";
import {
  parseApiTestShard,
  partitionTestFiles,
} from "../apps/api/scripts/test-file-shards";
import { durationSeconds } from "../apps/api/scripts/test-timings";
import { allApiTests } from "./api-test-impact";
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

const workflow = readFileSync(
  path.join(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf-8",
);

const ciTestsJob = (): string => {
  const marker = "\n  ci-tests:\n";
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const body = workflow.slice(start + marker.length);
  const next = body.search(/\n {2}[a-z][\w-]*:\n/u);
  return next === -1 ? body : body.slice(0, next);
};

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
  expect(ciTestsJob()).toContain(
    `matrix: \${{ fromJSON(needs.ci-plan.outputs.ci_tests_matrix) }}`,
  );
  const declared = planCiApiTests({
    event: "merge_group",
    scopeUnknown: false,
    apiInScope: true,
    select: allApiTests,
  }).matrix.shard;
  expect(declared).toEqual(Object.keys(TEST_JOB_SHARDS));
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
  const job = ciTestsJob();
  for (const name of ["Test API or rest", "Test web", "Test .claude/mcp"]) {
    const step = job
      .split(`      - name: ${name}\n`)
      .at(1)
      ?.split("      - name:")
      .at(0);
    expect(step).toBeDefined();
    expect(step).toContain("!cancelled()");
    expect(step).toContain(
      "needs.ci-plan.outputs.package_checks_required == 'true'",
    );
  }
  expect(job).toMatch(
    /SHARD: \$\{\{ matrix\.shard == 'rest-web' && 'rest' \|\| matrix\.shard \}\}/u,
  );
  expect(job).toContain("SHARD: web");
});

test("exactly one shard runs the .claude/mcp suite", () => {
  const job = ciTestsJob();
  expect(job.match(/bun --cwd \.claude\/mcp test/gu)).toHaveLength(1);
  const gate = /matrix\.shard == '(?<shard>[a-z-]+)'/u.exec(job)?.groups?.[
    "shard"
  ];
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
  expect(durations).not.toHaveProperty(newFile);
  const input = [...files, newFile];
  const selected = TEST_SHARD_IDS.flatMap((id) => {
    const shard = parseApiTestShard(apiShardValue(id));
    return shard === null
      ? []
      : (partitionTestFiles({
          files: input,
          durations: durationSeconds(durations),
          count: shard.count,
        }).at(shard.index - 1) ?? []);
  });
  expect(selected.toSorted()).toEqual(input.toSorted());
  expect(new Set(selected).size).toBe(input.length);
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
