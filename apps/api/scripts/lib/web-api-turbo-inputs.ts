import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import type { CompilerInputStamp } from "./compiler-input-stamp";

const ROOT_PREFIX = "$TURBO_ROOT$/";

const expandBraces = (pattern: string): string[] => {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (match === null) {
    return [pattern];
  }
  const [expression, alternatives = ""] = match;
  const start = match.index;
  return alternatives
    .split(",")
    .flatMap((alternative) =>
      expandBraces(
        `${pattern.slice(0, start)}${alternative}${pattern.slice(start + expression.length)}`,
      ),
    );
};

// Turbo inputs are globs; wildcards anywhere in a pattern must match.
const matches = (file: string, pattern: string) =>
  new Bun.Glob(pattern).match(file);

/**
 * Repository files the compiler read that Turbo would not rehash. A file is
 * covered when an input includes it and no input excludes it, or when a task
 * this one depends on declares it as an output (Turbo hashes that task).
 */
export const uncoveredCompilerInputs = (
  stamp: CompilerInputStamp,
  repoRoot: string,
  turboInputs: readonly string[],
  dependencyOutputs: readonly string[],
) => {
  const included = turboInputs
    .filter((input) => input.startsWith(ROOT_PREFIX) && !input.startsWith("!"))
    .flatMap((input) => expandBraces(input.slice(ROOT_PREFIX.length)));
  const excluded = turboInputs
    .filter((input) => input.startsWith(`!${ROOT_PREFIX}`))
    .flatMap((input) => expandBraces(input.slice(ROOT_PREFIX.length + 1)));
  const candidates = new Set([
    ...Object.entries(stamp.contents)
      .filter(([, hash]) => hash !== null)
      .map(([file]) => file),
    ...stamp.files.present,
  ]);
  return [...candidates]
    .map((file) => repoRelativePath(repoRoot, file))
    .filter(
      (file) =>
        file !== ".." &&
        !file.startsWith("../") &&
        !file.startsWith("node_modules/") &&
        !file.includes("/node_modules/") &&
        (!included.some((pattern) => matches(file, pattern)) ||
          excluded.some((pattern) => matches(file, pattern))) &&
        !dependencyOutputs.some((pattern) => matches(file, pattern)),
    )
    .toSorted();
};

const API_TYPES_TASK = "@stll/web#generate:api-types";

const turboConfigSchema = v.object({
  tasks: v.record(
    v.string(),
    v.looseObject({
      inputs: v.optional(v.array(v.string())),
      outputs: v.optional(v.array(v.string())),
      dependsOn: v.optional(v.array(v.string())),
    }),
  ),
});

const readTurboTasks = (repoRoot: string) => {
  const config = v.safeParse(
    turboConfigSchema,
    Bun.JSONC.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf-8")),
  );
  if (!config.success) {
    return panic("generate-web-api-types: turbo.json tasks are unreadable");
  }
  return config.output.tasks;
};

export const webApiTurboInputs = (repoRoot: string): string[] =>
  readTurboTasks(repoRoot)[API_TYPES_TASK]?.inputs ??
  panic(
    `generate-web-api-types: turbo.json has no string inputs for ${API_TYPES_TASK}`,
  );

const workspaceDirectories = (repoRoot: string) =>
  new Map(
    ["apps", "packages"].flatMap((group) =>
      readdirSync(path.join(repoRoot, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const directory = `${group}/${entry.name}`;
          const manifestPath = path.join(repoRoot, directory, "package.json");
          if (!existsSync(manifestPath)) {
            return [];
          }
          const manifest = v.safeParse(
            v.object({ name: v.string() }),
            Bun.JSONC.parse(readFileSync(manifestPath, "utf-8")),
          );
          return manifest.success
            ? [[manifest.output.name, directory] as const]
            : [];
        }),
    ),
  );

/**
 * Repository paths the API types task's dependencies declare as outputs.
 * A dependency without declared outputs contributes nothing, so its files
 * stay uncovered unless an input names them.
 */
export const webApiDependencyOutputs = (repoRoot: string): string[] => {
  const tasks = readTurboTasks(repoRoot);
  const [ownPackage = ""] = API_TYPES_TASK.split("#");
  const directories = workspaceDirectories(repoRoot);
  return (tasks[API_TYPES_TASK]?.dependsOn ?? []).flatMap((dependency) => {
    if (dependency.startsWith("^")) {
      return [];
    }
    const qualified = dependency.includes("#")
      ? dependency
      : `${ownPackage}#${dependency}`;
    const [packageName = ""] = qualified.split("#");
    const directory = directories.get(packageName);
    if (directory === undefined) {
      return [];
    }
    return (tasks[qualified]?.outputs ?? [])
      .filter((output) => !output.startsWith("!"))
      .map((output) => `${directory}/${output}`);
  });
};
