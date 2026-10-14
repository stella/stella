import { panic } from "better-result";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { FULL_TEST_JOB_SHARDS } from "./api-test-shard-plan";
import { GENERATORS } from "./generated-files";
import { parseLockfile, workspaceClosure } from "./landing-deploy-scope";
import { shardPackages, TEST_JOB_SHARDS } from "./test-shards";

const root = path.resolve(import.meta.dir, "..");
const manifestSchema = v.object({
  name: v.string(),
  scripts: v.optional(v.record(v.string(), v.string())),
});
const turboSchema = v.object({
  globalDependencies: v.optional(v.array(v.string()), []),
  tasks: v.record(
    v.string(),
    v.object({ inputs: v.optional(v.array(v.string()), []) }),
  ),
});
const workflowSchema = v.object({ jobs: v.record(v.string(), v.unknown()) });

export type SelectionGraph = {
  packages: ReadonlyMap<
    string,
    { directory: string; tests: boolean; dependencies: ReadonlySet<string> }
  >;
  inputs: ReadonlyMap<string, readonly string[]>;
  globalInputs: readonly string[];
};
export type CheckInputs = ReadonlyMap<string, readonly string[]>;

const matches = (file: string, input: string) =>
  file === input || new Bun.Glob(input).match(file);
const ownerOf = (file: string, graph: SelectionGraph) =>
  [...graph.packages].find(([, { directory }]) =>
    file.startsWith(`${directory}/`),
  )?.[0];

// Root tooling can inspect arbitrary repository files. Keep it global until
// its reader contract is declared; unknown inputs must never certify a skip.
const GLOBAL_INPUTS = [
  "bun.lock",
  "bun.lockb",
  "package.json",
  "bunfig.toml",
  ".npmrc",
  "turbo.json",
  "tsconfig*.json",
  "types/**",
  "patches/**",
  ".github/**",
  "scripts/**",
  ".oxlint-plugins/**",
  "oxlint*.ts",
  ".oxfmtrc*",
  "stll-toolchain.json",
  "packages/typescript-config/**",
  "**/package.json",
  "**/tsconfig*.json",
] as const;

export const readSelectionGraph = (repository = root): SelectionGraph => {
  const lock =
    parseLockfile(
      Bun.JSONC.parse(readFileSync(path.join(repository, "bun.lock"), "utf-8")),
    ) ?? panic("Cannot read workspace dependency graph");
  const turbo = v.parse(
    turboSchema,
    Bun.JSONC.parse(readFileSync(path.join(repository, "turbo.json"), "utf-8")),
  );
  const packages = new Map<
    string,
    { directory: string; tests: boolean; dependencies: ReadonlySet<string> }
  >();
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repository, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = `${parent}/${entry.name}`;
      const manifest = v.parse(
        manifestSchema,
        JSON.parse(
          readFileSync(
            path.join(repository, directory, "package.json"),
            "utf-8",
          ),
        ),
      );
      const closure =
        workspaceClosure(lock, manifest.name) ??
        panic(`Missing lockfile workspace: ${manifest.name}`);
      packages.set(manifest.name, {
        directory,
        tests: manifest.scripts?.["test"] !== undefined,
        dependencies: closure.workspaceDirectories,
      });
    }
  }
  const inputs = new Map<string, readonly string[]>();
  for (const [name, { directory }] of packages) {
    inputs.set(
      name,
      (turbo.tasks[`${name}#test`]?.inputs ?? turbo.tasks["test"]?.inputs ?? [])
        .filter(
          (input) => input !== "$TURBO_DEFAULT$" && !input.startsWith("!"),
        )
        .map((input) =>
          input.startsWith("$TURBO_ROOT$/")
            ? input.slice("$TURBO_ROOT$/".length)
            : `${directory}/${input}`,
        ),
    );
  }
  return {
    packages,
    inputs,
    globalInputs: [...GLOBAL_INPUTS, ...turbo.globalDependencies],
  };
};

// All workflow checks start conservatively with repository-wide inputs. The
// test shards have a narrower, executable contract owned by test-shards.ts.
// This table is the only place that promotes a check to package selection.
export const readCheckInputs = (
  graph: SelectionGraph,
  repository = root,
): CheckInputs => {
  const workflow = v.parse(
    workflowSchema,
    Bun.YAML.parse(
      readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  const checks = new Map(
    Object.keys(workflow.jobs).map((job) => [job, ["**"]]),
  );
  const names = [...graph.packages]
    .filter(([, value]) => value.tests)
    .map(([name]) => name);
  for (const [job, shards] of Object.entries(TEST_JOB_SHARDS)) {
    checks.set(`ci-tests (${job})`, [
      ...new Set(
        shards.flatMap((shard) =>
          shardPackages({ packageNames: names, shard }),
        ),
      ),
    ]);
  }
  return checks;
};

export const affectedPackages = (
  changed: readonly string[],
  graph: SelectionGraph,
) => {
  const affected = new Set<string>();
  const files = new Set(changed);
  if (
    changed.some((file) =>
      graph.globalInputs.some((input) => matches(file, input)),
    )
  ) {
    return new Set(graph.packages.keys());
  }
  // Generated files need not exist in a clean checkout. Propagate their input
  // identities to consumers, repeatedly, including generator-to-generator edges.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const generator of GENERATORS.filter(
      ({ outputKind }) => outputKind === "derived",
    )) {
      if (
        ![...files].some((file) =>
          generator.inputs.some((input) => matches(file, input)),
        )
      ) {
        continue;
      }
      for (const output of generator.outputs) {
        if (files.has(output)) {
          continue;
        }
        files.add(output);
        expanded = true;
      }
    }
  }
  for (const file of files) {
    const owner = ownerOf(file, graph);
    if (owner !== undefined) {
      affected.add(owner);
    }
    // An unowned root input has no declared boundary, so retain all packages.
    else {
      return new Set(graph.packages.keys());
    }
  }
  let widened = true;
  while (widened) {
    widened = false;
    const directories = new Set(
      [...affected].map(
        (name) =>
          graph.packages.get(name)?.directory ??
          panic(`Unknown affected package: ${name}`),
      ),
    );
    for (const [name, { dependencies }] of graph.packages) {
      if (
        affected.has(name) ||
        ![...dependencies].some((directory) => directories.has(directory))
      ) {
        continue;
      }
      affected.add(name);
      widened = true;
    }
  }
  // Filesystem readers select their test task, not downstream source consumers.
  for (const [name, inputs] of graph.inputs) {
    if (
      [...files].some((file) => inputs.some((input) => matches(file, input)))
    ) {
      affected.add(name);
    }
  }
  return affected;
};

type SelectChecksOptions = {
  changed: readonly string[];
  graph: SelectionGraph;
  checks: CheckInputs;
};

export const selectChecks = ({
  changed,
  graph,
  checks,
}: SelectChecksOptions) => {
  const affected = affectedPackages(changed, graph);
  const selected = new Set<string>();
  for (const [check, inputs] of checks) {
    for (const input of inputs) {
      if (input !== "**" && !graph.packages.has(input)) {
        panic(`Unknown package input for ${check}: ${input}`);
      }
    }
    if (inputs.some((input) => input === "**" || affected.has(input))) {
      selected.add(check);
    }
  }
  return { affected, selected };
};

export const selectedTestJobs = (
  changed: readonly string[],
  repository = root,
) => {
  const graph = readSelectionGraph(repository);
  const { selected } = selectChecks({
    changed,
    graph,
    checks: readCheckInputs(graph, repository),
  });
  return FULL_TEST_JOB_SHARDS.filter((shard) =>
    selected.has(`ci-tests (${shard})`),
  );
};
