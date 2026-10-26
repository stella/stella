import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { readSelectionGraph } from "./ci-affected-selection";
import { rootCheckGate } from "./ci-root-check-gate";
import {
  ROOT_CHECK_INPUTS,
  rootCheckInputs,
  selectRootChecks,
  validateRootCheckCensus,
} from "./ci-root-checks";
import { GENERATORS } from "./generated-files";
import { evaluate } from "./github-expression";
import { workflowJobSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dir, "..");
const graph = readSelectionGraph(root);
const inputs = rootCheckInputs(graph);
const dependencyFields = v.record(v.string(), v.string());
const manifestSchema = v.object({
  dependencies: v.optional(dependencyFields, {}),
  devDependencies: v.optional(dependencyFields, {}),
  optionalDependencies: v.optional(dependencyFields, {}),
  peerDependencies: v.optional(dependencyFields, {}),
});
const lockEntrySchema = v.looseObject({
  dependencies: v.optional(dependencyFields, {}),
  optionalDependencies: v.optional(dependencyFields, {}),
  peerDependencies: v.optional(dependencyFields, {}),
});
const lockSchema = v.object({
  packages: v.record(v.string(), v.array(v.unknown())),
});
// Published packages can depend on a workspace package, which the install
// links to the local copy (an app -> npm package -> workspace package path).
const externalDependencies = new Map(
  Object.entries(
    v.parse(
      lockSchema,
      Bun.JSONC.parse(readFileSync(path.join(root, "bun.lock"), "utf-8")),
    ).packages,
  ).map(([key, entry]) => {
    const fields = entry.find((item) => v.is(lockEntrySchema, item));
    if (fields === undefined) {
      return [key, []];
    }
    const { dependencies, optionalDependencies, peerDependencies } = v.parse(
      lockEntrySchema,
      fields,
    );
    return [
      key,
      [dependencies, optionalDependencies, peerDependencies].flatMap((field) =>
        Object.keys(field),
      ),
    ];
  }),
);
const dependencies = new Map([
  ...externalDependencies,
  ...[...graph.packages].map(
    ([name, { directory }]) =>
      [
        name,
        Object.values(
          v.parse(
            manifestSchema,
            JSON.parse(
              readFileSync(path.join(root, directory, "package.json"), "utf-8"),
            ),
          ),
        ).flatMap((field) => Object.keys(field)),
      ] as const,
  ),
]);
const closures = new Map<string, ReadonlySet<string>>();
const closureOf = (consumer: string) => {
  const cached = closures.get(consumer);
  if (cached !== undefined) {
    return cached;
  }
  const visited = new Set<string>();
  const queue = [consumer];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (visited.has(next)) {
      continue;
    }
    visited.add(next);
    queue.push(...(dependencies.get(next) ?? []));
  }
  closures.set(consumer, visited);
  return visited;
};
type ReachesOptions = { consumer: string; dependency: string };
const reaches = ({ consumer, dependency }: ReachesOptions) =>
  closureOf(consumer).has(dependency);

// Forward oracle: source owners produced by derived generators, then the
// actual manifest dependency closures of each check's consuming package.
const derivedFiles = (file: string) => {
  const files = new Set([file]);
  for (let previous = -1; previous !== files.size;) {
    previous = files.size;
    for (const generator of GENERATORS) {
      if (generator.outputKind !== "derived") {
        continue;
      }
      if (
        [...files].some((changed) =>
          generator.inputs.some((glob) => new Bun.Glob(glob).match(changed)),
        )
      ) {
        for (const output of generator.outputs) {
          files.add(output);
        }
      }
    }
  }
  return [...files];
};
const seedsForFiles = (files: readonly string[]) =>
  [...graph.packages]
    .filter(([, { directory }]) =>
      files.some((changed) => changed.startsWith(`${directory}/`)),
    )
    .map(([name]) => name);

const assertEnumeration = (table = inputs) => {
  for (const [name, { directory }] of graph.packages) {
    const file = `${directory}/src/probe.ts`;
    const files = derivedFiles(file);
    const seeds = seedsForFiles(files);
    const selected = new Set(
      selectRootChecks({
        changed: [file],
        graph,
        pathChange: "content",
        inputs: table,
      }),
    );
    for (const [check, paths] of inputs) {
      const expected = paths.some(
        (input) =>
          input === "**" ||
          (input.startsWith("@stll/")
            ? seeds.some((dependency) =>
                reaches({ consumer: input, dependency }),
              )
            : files.some((derived) => new Bun.Glob(input).match(derived))),
      );
      expect(selected.has(check), `${name} -> ${check}`).toBe(expected);
    }
  }
};

test("every package selects exactly the root checks reached by its declared source inputs", () =>
  assertEnumeration());

test("the root enumeration fails for a planted missing API reader edge", () => {
  const broken = new Map(inputs);
  const key = "ci-checks-policy/Processed-field backlog guard";
  const paths = broken.get(key) ?? panic("Missing backlog declaration");
  expect(paths).toContain("@stll/api");
  broken.set(
    key,
    paths.filter((input) => input !== "@stll/api"),
  );
  expect(() => assertEnumeration(broken)).toThrow(`@stll/api -> ${key}`);
});

test("all root workflow commands have declarations and narrow gates use the same owner", () => {
  const source = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  validateRootCheckCensus(source);
  const workflow: unknown = Bun.YAML.parse(source);
  for (const [job, checks] of Object.entries(ROOT_CHECK_INPUTS)) {
    // Pooled checks are steps of their job; see scripts/workflow-steps.ts.
    const steps = workflowJobSteps(workflow, job);
    for (const [name, paths] of Object.entries(checks)) {
      if (paths.includes("**")) {
        continue;
      }
      const step = steps.find((candidate) => candidate["name"] === name);
      expect(String(step?.["if"])).toContain(rootCheckGate({ job, name }));
    }
  }
  const broken = structuredClone(ROOT_CHECK_INPUTS);
  delete broken["ci-checks-policy"]["Processed-field backlog guard"];
  expect(() => validateRootCheckCensus(source, broken)).toThrow(
    "Root check input census differs",
  );
});

test("steps whose success or outputs later steps consume cannot be deselected", () => {
  const source = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const job = "ci-checks-rest";
  const name = "Tauri package alignment";
  const id = "id: tauri_alignment\n        if: ${{ !cancelled()";
  expect(source).toContain(id);
  const broken = structuredClone(ROOT_CHECK_INPUTS);
  broken[job][name] = ["@stll/unrelated"];
  expect(() =>
    validateRootCheckCensus(
      source.replace(id, () => `${id} && ${rootCheckGate({ job, name })}`),
      broken,
    ),
  ).toThrow(`Root check gate skips a consumed step: ${job}/${name}`);
});

test("global configuration and structural path changes retain full root scope", () => {
  for (const changed of [
    ["bun.lock"],
    [".github/workflows/ci.yml"],
    ["scripts/ci-root-checks.ts"],
    ["apps/api/scripts/new.ts"],
    ["packages/scripts/src/child-exit-status.ts"],
    ["packages/property-testing/src/index.ts"],
    ["packages/portable-path/src/index.ts"],
  ]) {
    const options = { changed, graph, pathChange: "content" } as const;
    expect(selectRootChecks(options)).toHaveLength(inputs.size);
  }
  const structural = {
    changed: ["apps/landing/src/new.ts"],
    graph,
    pathChange: "structure",
  } as const;
  expect(selectRootChecks(structural)).toHaveLength(inputs.size);
});

test("leaf, core and merge-batch changes preserve the union over the same selector", () => {
  const files = ["apps/landing/src/page.ts", "packages/sha256/src/hash.ts"];
  const options = { graph, pathChange: "content" } as const;
  const leaf = selectRootChecks({ ...options, changed: files.slice(0, 1) });
  expect(leaf).not.toContain("ci-checks-policy/Processed-field backlog guard");
  const core = selectRootChecks({ ...options, changed: files.slice(1) });
  expect(core).toContain("ci-checks-policy/Processed-field backlog guard");
  const union = [...new Set([...leaf, ...core])].toSorted();
  expect(selectRootChecks({ ...options, changed: files }).toSorted()).toEqual(
    union,
  );
});

test("i18n scopes derive every live workspace participant", () => {
  const participants = [...graph.packages]
    .filter(([, owner]) => owner.scripts["i18n:check"] !== undefined)
    .map(([name]) => name);
  const declared =
    inputs.get("ci-checks-rest/Check i18n sync") ?? panic("Missing i18n check");
  for (const name of participants) {
    expect(declared).toContain(name);
  }
  expect(participants).toContain("@stll/transactional");
});

test("workflow gates honor selection and retain all checks when planning is unavailable", () => {
  const selected = selectRootChecks({
    changed: ["apps/landing/src/probe.ts"],
    graph,
    pathChange: "content",
  });
  for (const [job, checks] of Object.entries(ROOT_CHECK_INPUTS)) {
    for (const name of Object.keys(checks)) {
      const gate = rootCheckGate({ job, name });
      for (const output of ["", JSON.stringify(selected)]) {
        expect(
          evaluate(gate, {
            values: { "needs.ci-plan.outputs.root_checks": output },
          }),
        ).toBe(output === "" || selected.includes(`${job}/${name}`));
      }
    }
  }
});

test("derived capability inputs retain API readers and shell bodies retain lockfile validation", () => {
  const isolated = {
    ...graph,
    packages: new Map(
      [...graph.packages].map(([name, owner]) => [
        name,
        { ...owner, dependencies: new Set<string>() },
      ]),
    ),
  };
  for (const { file, check } of [
    {
      file: "packages/cli/capabilities/probe.json",
      check: "ci-checks-policy/Processed-field backlog guard",
    },
    {
      file: "packages/sha256/install.sh",
      check: "ci-checks-rest/Standalone lockfile guard",
    },
  ]) {
    expect(
      selectRootChecks({
        changed: [file],
        graph: isolated,
        pathChange: "content",
      }),
    ).toContain(check);
  }
});
