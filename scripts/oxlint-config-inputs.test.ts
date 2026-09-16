import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { OXLINT_CONFIGURATION_CACHE_INPUTS } from "./code-check-affected";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CONFIG_PATH = "oxlint.config.ts";
const TURBO_PATH = "turbo.json";
const ROOT_PREFIX = "$TURBO_ROOT$/";

const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

/** Repo-relative paths `oxlint.config.ts` imports with a relative specifier. */
const configImports = (): string[] =>
  Array.from(
    read(CONFIG_PATH).matchAll(/from "\.\/(?<file>[^"]+)"/gu),
    (match) => match.groups?.["file"],
  ).filter((file): file is string => file !== undefined);

const covers = (input: string, file: string): boolean => {
  const pattern = input.slice(ROOT_PREFIX.length);
  return pattern.endsWith("/**")
    ? file.startsWith(pattern.slice(0, -"**".length))
    : pattern === file;
};

// A module the lint config imports is rule configuration: editing it changes
// what every workspace lint reports, so it has to invalidate the cached lint
// results and select the workspaces in the affected planner.
test("every module oxlint.config.ts imports is a lint cache input", () => {
  const uncovered = configImports().filter(
    (file) =>
      !OXLINT_CONFIGURATION_CACHE_INPUTS.some((input) => covers(input, file)),
  );

  expect(uncovered).toEqual([]);
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
