import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { parseSource } from "../packages/scripts/src/syntax-tree.ts";
import { OXLINT_CONFIGURATION_CACHE_INPUTS } from "./code-check-affected";
import { lintModuleClosure } from "./oxlint-module-closure.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CONFIG_PATH = "oxlint.config.ts";
const TURBO_PATH = "turbo.json";
const ROOT_PREFIX = "$TURBO_ROOT$/";

const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

const covers = (input: string, file: string): boolean => {
  const pattern = input.slice(ROOT_PREFIX.length);
  return new Bun.Glob(pattern).match(file);
};

test("every discovered ownership declaration invalidates lint caches", () => {
  const sources = [
    "scripts/ownership-loader.ts",
    "scripts/ownership-types.ts",
    ...readdirSync(path.join(REPO_ROOT, "scripts/ownership"))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => `scripts/ownership/${file}`),
  ];
  expect(sources.length).toBeGreaterThan(2);
  expect(
    sources.filter(
      (file) =>
        !OXLINT_CONFIGURATION_CACHE_INPUTS.some((input) => covers(input, file)),
    ),
  ).toEqual([]);
  expect(
    OXLINT_CONFIGURATION_CACHE_INPUTS.some((input) =>
      covers(input, "scripts/ownership/new-capability.ts"),
    ),
  ).toBe(true);
});

const closure = lintModuleClosure(REPO_ROOT);

// A module the lint configs or their plugins load is rule configuration:
// editing it changes what every workspace lint reports, so it has to
// invalidate the cached lint results and select the workspaces in the
// affected planner. An app's own module is the exception the planner's list
// documents: it stays an input of that app's lint through its default inputs
// unless a rule reads it for other workspaces, which the list then names.
test("every module the lint configs and plugins load is a lint cache input", () => {
  expect(closure.modules.length).toBeGreaterThan(100);
  expect(
    closure.modules.filter(
      (file) =>
        !file.startsWith("apps/") &&
        !OXLINT_CONFIGURATION_CACHE_INPUTS.some((input) => covers(input, file)),
    ),
  ).toEqual([]);
});

// The other direction: a named input is either a loaded module or a file a
// loaded module reads by name (a baseline, a ledger). One no loaded module
// names any more only invalidates caches for nothing.
test("every named lint cache input is loaded or read by the lint", () => {
  const loaded = closure.modules.map((file) => read(file));
  expect(
    OXLINT_CONFIGURATION_CACHE_INPUTS.map((input) =>
      input.slice(ROOT_PREFIX.length),
    ).filter(
      (file) =>
        !/[*?[{]/u.test(file) &&
        !closure.modules.includes(file) &&
        !loaded.some((text) => text.includes(path.basename(file))),
    ),
  ).toEqual([]);
});

// Oxlint runs JS plugins under Node, whose ES module loader resolves a
// relative import only by its full file name; an extensionless one stops the
// whole lint from loading.
test("every relative import in the lint module closure names its file", () => {
  expect(closure.relativeImports.length).toBeGreaterThan(100);
  expect(
    closure.relativeImports
      .filter(({ specifier }) => !/\.(?:[cm]?[jt]sx?|json)$/u.test(specifier))
      .map(({ file, specifier }) => `${file}: ${specifier}`),
  ).toEqual([]);
});

type TurboTasks = Record<string, { inputs?: string[] }>;

/** turbo.json is JSONC; its comments are whole `//` lines. */
const turboTasks = (): TurboTasks => {
  const source = read(TURBO_PATH)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const parsed: { tasks: TurboTasks } = JSON.parse(source);
  return parsed.tasks;
};

// turbo.json cannot import the planner's list, so every task that runs Oxlint
// repeats it. A task is one that runs Oxlint when it lists the config.
/**
 * Relative value imports of every module the lint config and its JS plugins
 * load, transitively. Type-only imports are erased before anything runs.
 */
const lintModuleImports = (): { file: string; specifier: string }[] => {
  const pending = [
    CONFIG_PATH,
    ...readdirSync(path.join(REPO_ROOT, ".oxlint-plugins"))
      .filter((file) => /\.[cm]?ts$/u.test(file))
      .map((file) => `.oxlint-plugins/${file}`),
  ];
  const seen = new Set<string>();
  const imports: { file: string; specifier: string }[] = [];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const { module } = parseSource(file, read(file));
    const specifiers = [
      ...module.staticImports
        .filter(
          ({ entries }) =>
            entries.length === 0 || entries.some(({ isType }) => !isType),
        )
        .map(({ moduleRequest }) => moduleRequest.value),
      ...module.staticExports.flatMap(({ entries }) =>
        entries.flatMap(({ isType, moduleRequest }) =>
          moduleRequest === null || isType ? [] : [moduleRequest.value],
        ),
      ),
    ];
    for (const specifier of specifiers.filter((value) =>
      value.startsWith("."),
    )) {
      imports.push({ file, specifier });
      const target = repoRelativePath(
        REPO_ROOT,
        path.resolve(REPO_ROOT, path.dirname(file), specifier),
      );
      const source = [target, `${target}.ts`].find(
        (candidate) =>
          /\.[cm]?[jt]sx?$/u.test(candidate) &&
          existsSync(path.join(REPO_ROOT, candidate)),
      );
      if (source !== undefined) {
        pending.push(source);
      }
    }
  }
  return imports;
};

// Oxlint runs JS plugins under Node, whose ES module loader resolves a
// relative import only by its full file name; an extensionless one stops the
// whole lint from loading.
test("every relative import the lint plugins load names its file", () => {
  const imports = lintModuleImports();
  expect(imports.length).toBeGreaterThan(100);
  expect(
    imports
      .filter(({ specifier }) => !/\.(?:[cm]?[jt]sx?|json)$/u.test(specifier))
      .map(({ file, specifier }) => `${file}: ${specifier}`),
  ).toEqual([]);
});

test("every Turbo task that runs Oxlint lists every lint cache input", () => {
  const configInput = `${ROOT_PREFIX}${CONFIG_PATH}`;
  const lintTasks = Object.entries(turboTasks()).filter(
    ([name, task]) =>
      name.includes("lint") && (task.inputs ?? []).includes(configInput),
  );

  expect(lintTasks.length).toBeGreaterThan(0);
  expect(
    lintTasks.flatMap(([name, task]) =>
      OXLINT_CONFIGURATION_CACHE_INPUTS.filter(
        (input) => !(task.inputs ?? []).includes(input),
      ).map((input) => `${name}: ${input}`),
    ),
  ).toEqual([]);
});
