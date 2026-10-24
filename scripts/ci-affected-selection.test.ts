import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  affectedPackages,
  type CheckInputs,
  readCheckInputs,
  readSelectionGraph,
  selectChecks,
} from "./ci-affected-selection";
import { GENERATORS } from "./generated-files";
import { shardPackages, TEST_JOB_SHARDS } from "./test-shards";

const root = path.resolve(import.meta.dir, "..");
const graph = readSelectionGraph(root);
const checks = readCheckInputs(graph, root);
const dependencySchema = v.record(v.string(), v.string());
const manifestSchema = v.object({
  dependencies: v.optional(dependencySchema, {}),
  devDependencies: v.optional(dependencySchema, {}),
  optionalDependencies: v.optional(dependencySchema, {}),
  peerDependencies: v.optional(dependencySchema, {}),
});

// Independent oracle: walk forward through package manifests, rather than
// reusing the selector's lockfile closure or reverse-dependent traversal.
const reaches = (
  consumer: string,
  dependency: string,
  seen = new Set<string>(),
): boolean => {
  if (consumer === dependency) {
    return true;
  }
  if (seen.has(consumer)) {
    return false;
  }
  seen.add(consumer);
  const workspace = graph.packages.get(consumer);
  if (workspace === undefined) {
    return false;
  }
  const manifest = v.parse(
    manifestSchema,
    JSON.parse(
      readFileSync(
        path.join(root, workspace.directory, "package.json"),
        "utf-8",
      ),
    ),
  );
  return Object.values(manifest).some((field) =>
    Object.keys(field).some(
      (name) => graph.packages.has(name) && reaches(name, dependency, seen),
    ),
  );
};

const oracleInputs = new Map(checks);
const names = [...graph.packages]
  .filter(([, value]) => value.tests)
  .map(([name]) => name);
for (const [job, shards] of Object.entries(TEST_JOB_SHARDS)) {
  oracleInputs.set(
    `ci-tests (${job})`,
    shards.flatMap((shard) => shardPackages({ packageNames: names, shard })),
  );
}

const assertEnumeration = (table: CheckInputs) => {
  expect([...table.keys()].toSorted()).toEqual(
    [...oracleInputs.keys()].toSorted(),
  );
  for (const [name, { directory }] of graph.packages) {
    const file = `${directory}/src/__affected_probe__.ts`;
    const { selected } = selectChecks({
      changed: [file],
      graph,
      checks: table,
    });
    for (const [check, inputs] of oracleInputs) {
      const expected = inputs.some(
        (input) =>
          input === "**" ||
          reaches(input, name) ||
          (graph.inputs.get(input) ?? []).some((pattern) =>
            new Bun.Glob(pattern).match(file),
          ),
      );
      expect(selected.has(check), `${name} -> ${check}`).toBe(expected);
    }
  }
};

test("every workspace change selects exactly the checks reachable through declared inputs", () => {
  assertEnumeration(checks);
});

test("the enumeration detects a deliberately missing API shard ownership edge", () => {
  const broken = new Map(checks);
  broken.set("ci-tests (api-1)", []);
  expect(() => assertEnumeration(broken)).toThrow(
    "@stll/api -> ci-tests (api-1)",
  );
});

test("lockfiles, workflow and CI tooling changes select every declared check", () => {
  for (const file of [
    "bun.lock",
    ".github/workflows/ci.yml",
    "scripts/ci-api-test-plan.ts",
    "turbo.json",
    "packages/typescript-config/base.json",
  ]) {
    const { selected, affected } = selectChecks({
      changed: [file],
      graph,
      checks,
    });
    expect(affected.size).toBe(graph.packages.size);
    expect(selected.size).toBe(checks.size);
  }
});

test("leaf and shared core changes follow actual dependencies", () => {
  const core = affectedPackages(["packages/sha256/src/probe.ts"], graph);
  expect(core.has("@stll/api")).toBe(true);
  expect(core.has("@stll/web")).toBe(true);
  const landing = affectedPackages(
    ["apps/landing/src/__affected_probe__.ts"],
    graph,
  );
  expect(landing.has("@stll/landing")).toBe(true);
  expect(landing.has("@stll/api")).toBe(false);
});

test("derived generator inputs select their output owners even before output files exist", () => {
  const generator = GENERATORS.find(({ id }) => id === "capability-runtime");
  expect(generator).toBeDefined();
  expect(generator?.inputs).toContain("packages/cli/capabilities/**");
  expect(
    generator?.outputs.some((output) => output.startsWith("apps/api/")),
  ).toBe(true);
  const isolated = {
    ...graph,
    packages: new Map(
      [...graph.packages].map(([name, value]) => [
        name,
        { ...value, dependencies: new Set<string>() },
      ]),
    ),
    inputs: new Map<string, readonly string[]>(),
  };
  expect(
    affectedPackages(["packages/cli/capabilities/probe.json"], isolated).has(
      "@stll/api",
    ),
  ).toBe(true);
});

test("merge batch selection equals the union of each constituent selection", () => {
  const files = [
    "apps/landing/src/probe.ts",
    "packages/sha256/src/probe.ts",
    "apps/web/src/probe.ts",
  ];
  const batch = selectChecks({ changed: files, graph, checks });
  const union = new Set(
    files.flatMap((file) => [
      ...selectChecks({ changed: [file], graph, checks }).selected,
    ]),
  );
  expect([...batch.selected].toSorted()).toEqual([...union].toSorted());
});

test("test matrix admission has one graph owner and no independent path filter", () => {
  const planner = readFileSync(
    path.join(root, "scripts/ci-api-test-plan.ts"),
    "utf-8",
  );
  expect(planner).toContain("selectedTestJobs(output.slice(jsonStart), root)");
  expect(planner).toContain('"bun", "scripts/test-scope.ts"');
  expect(planner).toContain('"--dry=json"');
  const workflow = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  expect(workflow).toContain(
    "(github.event_name == 'pull_request' || github.event_name == 'merge_group') && steps.planner-deps.outcome == 'success' && steps.api-test-deps.outcome == 'success'",
  );
  expect(workflow).toContain(
    `TEST_SCOPE: \${{ needs.ci-plan.outputs.test_scope }}`,
  );
});
