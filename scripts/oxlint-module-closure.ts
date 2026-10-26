import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import { parseSource } from "../packages/scripts/src/syntax-tree.ts";

/** The configs every workspace lint runs with. */
const OXLINT_CONFIG_PATHS = [
  "oxlint.config.ts",
  "oxlint.result-boundary.config.ts",
] as const;
const OXLINT_PLUGIN_DIRECTORY = ".oxlint-plugins";

const SCRIPT_MODULE = /\.(?:[cm]?[jt]sx?)$/u;

type ModuleImport = { file: string; specifier: string };

type LintModuleClosure = {
  /** Repository files the lint config and its plugins load, transitively. */
  readonly modules: readonly string[];
  /** Every relative value import among them, by importing file. */
  readonly relativeImports: readonly ModuleImport[];
};

// The static graph is what loading a plugin evaluates; a dynamic import runs
// only on the code path that calls it (a CLI branch, not a lint run).
const valueSpecifiers = (file: string, text: string): string[] => {
  const { module } = parseSource(file, text);
  return [
    // A type-only import is erased before the module runs.
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
};

/**
 * The repository file a specifier loads, or undefined when it is a package
 * installed from the registry (or not resolvable at all). Workspace packages
 * resolve through their links to the sources in the repository.
 */
const repositoryTarget = (
  root: string,
  importer: string,
  specifier: string,
): string | undefined => {
  // Module resolution is a filesystem boundary.
  try {
    const resolved = realpathSync(
      Bun.resolveSync(specifier, path.dirname(path.join(root, importer))),
    );
    if (!isPathInside(root, resolved)) {
      return undefined;
    }
    const file = repoRelativePath(root, resolved);
    return file.split("/").includes("node_modules") ? undefined : file;
  } catch {
    return undefined;
  }
};

/**
 * Walks the import graph of the lint configs and every plugin module,
 * following relative imports and workspace packages into the repository.
 */
export const lintModuleClosure = (
  repositoryRoot: string,
): LintModuleClosure => {
  const root = realpathSync(repositoryRoot);
  const pending: string[] = [
    ...OXLINT_CONFIG_PATHS,
    ...[
      ...new Bun.Glob(`${OXLINT_PLUGIN_DIRECTORY}/*.{ts,mts,cts}`).scanSync({
        cwd: root,
      }),
    ].toSorted(),
  ];
  const modules = new Set<string>();
  const relativeImports: ModuleImport[] = [];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (modules.has(file)) {
      continue;
    }
    modules.add(file);
    if (!SCRIPT_MODULE.test(file)) {
      continue;
    }
    for (const specifier of valueSpecifiers(
      file,
      readFileSync(path.join(root, file), "utf-8"),
    )) {
      if (specifier.startsWith(".")) {
        relativeImports.push({ file, specifier });
      }
      const target = repositoryTarget(root, file, specifier);
      if (target !== undefined && existsSync(path.join(root, target))) {
        pending.push(target);
      }
    }
  }
  return {
    modules: [...modules].toSorted(),
    relativeImports,
  };
};
