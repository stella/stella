#!/usr/bin/env bun

import { Result } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildImportGraph } from "./api-test-impact";
import {
  allChangedSpecSuiteSpecs,
  BrowserSuiteDeclarationError,
  browserSuiteRunInputs,
  type BrowserSuiteSpecs,
  browserSuiteSpecs,
  browserSuiteTestDir,
  CHANGED_SPEC_SUITES,
  type ChangedSpecSuite,
  ciBrowserSuiteLegs,
  coveredBy,
} from "./ci-browser-suites";
import { cachedForRepository } from "./ci-repository-cache";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MODULE = /\.[cm]?[jt]sx?$/u;

type SuiteGraph =
  | { readable: false }
  | {
      readable: true;
      closures: ReadonlyMap<string, ReadonlySet<string>>;
      /** Modules the config and global setup load: all specs depend on them. */
      runClosure: ReadonlySet<string>;
      /** A reached module the graph cannot follow (computed, reads, fails). */
      uncertain: boolean;
    };

const graphs = new Map<string, SuiteGraph>();

// One graph per suite, from its specs and the modules Playwright loads for
// every spec. Workspace imports resolve through the packages' exports.
const suiteGraph = (suite: ChangedSpecSuite, root: string): SuiteGraph =>
  cachedForRepository(graphs, { root, key: suite.id }, () => {
    const specs = browserSuiteSpecs(suite, root);
    const runModules = browserSuiteRunInputs(suite, root).filter(
      (file) => MODULE.test(file) && existsSync(path.join(root, file)),
    );
    const built = Result.try(() =>
      buildImportGraph(root, [...specs, ...runModules]),
    );
    if (built.isErr()) {
      return { readable: false };
    }
    const graph = built.value;
    const closures = new Map(specs.map((spec) => [spec, graph.closure(spec)]));
    const runClosure = new Set(
      runModules.flatMap((module) => [...graph.closure(module)]),
    );
    const reached = [
      ...runClosure,
      ...[...closures.values()].flatMap((closure) => [...closure]),
    ];
    return {
      readable: true,
      closures,
      runClosure,
      uncertain: reached.some(
        (file) =>
          graph.failed.has(file) ||
          graph.computedImports.has(file) ||
          graph.readers.has(file) ||
          graph.scanners.has(file),
      ),
    };
  });

const selectSuiteSpecs = (
  suite: ChangedSpecSuite,
  changed: readonly string[],
  root: string,
): readonly string[] => {
  const specs = browserSuiteSpecs(suite, root);
  if (specs.length === 0) {
    return [];
  }
  const inputs = browserSuiteRunInputs(suite, root);
  if (changed.some((file) => inputs.some((input) => coveredBy(file, input)))) {
    return specs;
  }
  const graph = suiteGraph(suite, root);
  if (!graph.readable) {
    return specs;
  }
  const files = new Set(changed);
  if (changed.some((file) => graph.runClosure.has(file))) {
    return specs;
  }
  // A module that reads files or computes imports may load any file of the
  // suite's test directory, so a change there selects every spec.
  if (graph.uncertain) {
    const testDir = browserSuiteTestDir(suite, root);
    if (changed.some((file) => coveredBy(file, testDir))) {
      return specs;
    }
  }
  return specs.filter((spec) =>
    [...(graph.closures.get(spec) ?? [])].some((file) => files.has(file)),
  );
};

/**
 * The specs of each changed-spec suite a pull request runs: a changed spec,
 * a spec whose static import closure (workspace imports included) holds a
 * changed module, and every spec when the suite's run inputs or the modules
 * its config loads change, when its graph cannot be built, or when its
 * graph holds a module it cannot follow and a file of its test directory
 * changed. `all` selects every spec, for a change set that cannot be read.
 */
export const changedBrowserSuiteSpecs = (
  changed: readonly string[],
  {
    root = REPO_ROOT,
    all = false,
  }: { root?: string | undefined; all?: boolean | undefined } = {},
): BrowserSuiteSpecs => {
  if (all) {
    return allChangedSpecSuiteSpecs(root);
  }
  const selected = CHANGED_SPEC_SUITES.flatMap((suite) => {
    const specs = selectSuiteSpecs(suite, changed, root);
    return specs.length > 0 ? [[suite.id, [...specs]] as const] : [];
  });
  const selection: BrowserSuiteSpecs = Object.fromEntries(selected);
  return selection;
};

const readChangedPaths = (file: string | undefined): string[] => {
  if (file === undefined || !existsSync(file)) {
    throw new BrowserSuiteDeclarationError(
      "The pull request's changed paths are missing",
    );
  }
  return readFileSync(file, "utf-8").split("\0").filter(Boolean);
};

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command !== "plan") {
    throw new BrowserSuiteDeclarationError(
      "Usage: ci-browser-suite-selection.ts plan",
    );
  }
  const selection =
    process.env["EVENT_NAME"] === "pull_request"
      ? changedBrowserSuiteSpecs(
          readChangedPaths(process.env["BROWSER_SUITE_CHANGED_PATHS"]),
          { all: process.env["SCOPE_UNKNOWN"] === "true" },
        )
      : {};
  process.stdout.write(
    `legs=${JSON.stringify(ciBrowserSuiteLegs(selection))}\n`,
  );
}
