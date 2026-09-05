#!/usr/bin/env bun

// Fast local code-quality gate.
//
// Pre-push and pull-request CI use this wrapper to ask Turbo for changed
// workspaces plus reverse dependants. Known global inputs widen only the check
// family they can affect, preserving independent lint and typecheck cache hits.
// Root scripts sit outside workspace tasks, so changed root sources are linted
// directly and root TypeScript projects run through a cacheable Turbo root task.
// Inconsistent affected-workspace output still fails safe to the monolithic
// repository check.

import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { isChangedLintPath } from "./lint-paths";
import {
  isResultConventionExcludedFile,
  isResultConventionSourceFile,
} from "./result-boundary-globs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";
const WORKSPACE_PARENTS = ["apps", "packages"] as const;
const RESULT_BOUNDARY_BASELINE_PATH = path.join(
  REPO_ROOT,
  "scripts/ratchet-baseline.json",
);
const RESULT_BOUNDARY_METRICS = [
  "throw-outside-boundary",
  "try-catch-outside-boundary",
] as const;

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Files already tracked by the result ratchet carry deliberate legacy debt.
 * The ratchet rejects any increase; running the strict lint over those files
 * rejects every existing violation as well, so a change unrelated to that
 * debt cannot pass the affected-file gate. Keep the two guards monotone by
 * linting only files with no baseline entry here.
 */
const readResultBoundaryBaselineFiles = (): ReadonlySet<string> => {
  const parsed: unknown = JSON.parse(
    readFileSync(RESULT_BOUNDARY_BASELINE_PATH, "utf-8"),
  );
  if (!isJsonRecord(parsed)) {
    panic("result-boundary ratchet baseline must be an object");
  }

  const files = new Set<string>();
  for (const metric of RESULT_BOUNDARY_METRICS) {
    const snapshot = parsed[metric];
    if (!isJsonRecord(snapshot) || !isJsonRecord(snapshot["files"])) {
      panic(`result-boundary ratchet baseline is missing ${metric}.files`);
    }
    for (const file of Object.keys(snapshot["files"])) {
      files.add(file);
    }
  }
  return files;
};

const RESULT_BOUNDARY_BASELINE_FILES = readResultBoundaryBaselineFiles();

export const DEPENDENCY_CACHE_INPUTS = [
  "$TURBO_ROOT$/.npmrc",
  "$TURBO_ROOT$/bun.lock",
  "$TURBO_ROOT$/bunfig.toml",
  "$TURBO_ROOT$/package.json",
  "$TURBO_ROOT$/patches/**",
] as const;
export const SHARED_COMPILER_CACHE_INPUTS = [
  "$TURBO_ROOT$/packages/typescript-config/**",
  "$TURBO_ROOT$/types/**",
] as const;
export const ALL_WORKSPACE_CACHE_INPUTS = [
  ...DEPENDENCY_CACHE_INPUTS,
  ...SHARED_COMPILER_CACHE_INPUTS,
] as const;
export const TYPECHECK_ONLY_CACHE_INPUTS = [
  "$TURBO_ROOT$/packages/scripts/src/tsc-native.ts",
] as const;
export const ALL_WORKSPACE_TYPECHECK_CACHE_INPUTS = [
  ...ALL_WORKSPACE_CACHE_INPUTS,
  ...TYPECHECK_ONLY_CACHE_INPUTS,
] as const;
const OXLINT_CONFIGURATION_CACHE_INPUTS = [
  "$TURBO_ROOT$/oxlint.config.ts",
  "$TURBO_ROOT$/oxlint.result-boundary.config.ts",
  "$TURBO_ROOT$/.oxlint-plugins/**",
  // The ownership table is rule configuration: `oxlint.config.ts` builds
  // `confine-owner`'s options from it, so a row edited here changes what every
  // workspace lint reports.
  "$TURBO_ROOT$/scripts/ownership.ts",
] as const;
export const LINT_ONLY_CACHE_INPUTS = [
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/tsconfig.tooling.json",
] as const;
export const PLUGIN_FIXTURE_INPUTS = [
  ...DEPENDENCY_CACHE_INPUTS,
  ...SHARED_COMPILER_CACHE_INPUTS,
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/scripts/lint-oxlint-fixtures.sh",
  "$TURBO_ROOT$/scripts/oxlint-safe-fixers.test.ts",
  "$TURBO_ROOT$/tsconfig.json",
  "$TURBO_ROOT$/tsconfig.oxlint-plugins.json",
] as const;
export const PLUGIN_REGISTRY_INPUTS = [
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/scripts/check-oxlint-plugin-registry.ts",
] as const;
export const ROOT_SCRIPT_LINT_INPUTS = [
  ...ALL_WORKSPACE_CACHE_INPUTS,
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/scripts/lint-root-scripts.sh",
  "$TURBO_ROOT$/scripts/tsconfig.json",
  "$TURBO_ROOT$/tsconfig.scripts.json",
] as const;
const TURBO_CONFIG_PATH = "turbo.json";
const TURBO_ROOT_INPUT_PREFIX = "$TURBO_ROOT$/";
const RECURSIVE_GLOB_SUFFIX = "/**";

const ROOT_CHECKS = {
  assets: "assets",
  env: "env",
  pluginFixtures: "plugin-fixtures",
  pluginRegistry: "plugin-registry",
  repoTypecheck: "repo-typecheck",
  rootScriptLint: "root-script-lint",
} as const;
type RootCheck = (typeof ROOT_CHECKS)[keyof typeof ROOT_CHECKS];
const ROOT_CHECK_ORDER: readonly RootCheck[] = [
  ROOT_CHECKS.env,
  ROOT_CHECKS.assets,
  ROOT_CHECKS.pluginRegistry,
  ROOT_CHECKS.pluginFixtures,
  ROOT_CHECKS.rootScriptLint,
  ROOT_CHECKS.repoTypecheck,
];

type TaskScope = { type: "all" } | { type: "targets"; targets: string[] };

type ScopedCheckPlan = {
  type: "scoped";
  lint: TaskScope;
  typecheck: TaskScope;
  rootLintPaths: string[];
  rootChecks: RootCheck[];
};

type CheckPlan = { type: "fallback"; changedPath: string } | ScopedCheckPlan;

type PlanCheckOptions = {
  changedPaths: readonly string[];
  presentChangedPaths: readonly string[];
  affectedWorkspacePaths: readonly string[];
  workspacePaths: ReadonlySet<string>;
};

const workspaceForPath = (file: string): string | null => {
  const segments = file.split("/");
  const parent = segments.at(0);
  const name = segments.at(1);
  if (
    parent === undefined ||
    name === undefined ||
    !WORKSPACE_PARENTS.some((workspaceParent) => workspaceParent === parent)
  ) {
    return null;
  }
  return `${parent}/${name}`;
};

const matchesTurboInput = (file: string, input: string): boolean => {
  if (!input.startsWith(TURBO_ROOT_INPUT_PREFIX)) {
    return false;
  }
  const relativeInput = input.slice(TURBO_ROOT_INPUT_PREFIX.length);
  if (!relativeInput.endsWith(RECURSIVE_GLOB_SUFFIX)) {
    return file === relativeInput;
  }
  const directory = relativeInput.slice(0, -RECURSIVE_GLOB_SUFFIX.length);
  return file.startsWith(`${directory}/`);
};

const invalidatesAllWorkspaceChecks = (file: string): boolean =>
  file === TURBO_CONFIG_PATH ||
  ALL_WORKSPACE_CACHE_INPUTS.some((input) => matchesTurboInput(file, input));

const invalidatesAllWorkspaceTypecheck = (file: string): boolean =>
  invalidatesAllWorkspaceChecks(file) ||
  TYPECHECK_ONLY_CACHE_INPUTS.some((input) => matchesTurboInput(file, input));

const invalidatesRootScriptLint = (file: string): boolean =>
  ROOT_SCRIPT_LINT_INPUTS.some((input) => matchesTurboInput(file, input));

const rootChecksForPath = (file: string): readonly RootCheck[] => {
  const rootChecks: RootCheck[] = [];
  if (PLUGIN_REGISTRY_INPUTS.some((input) => matchesTurboInput(file, input))) {
    rootChecks.push(ROOT_CHECKS.pluginRegistry);
  }
  if (PLUGIN_FIXTURE_INPUTS.some((input) => matchesTurboInput(file, input))) {
    rootChecks.push(ROOT_CHECKS.pluginFixtures);
  }
  if (invalidatesRootScriptLint(file)) {
    rootChecks.push(ROOT_CHECKS.rootScriptLint);
  }
  return rootChecks;
};

export const planCheck = ({
  changedPaths,
  presentChangedPaths,
  affectedWorkspacePaths,
  workspacePaths,
}: PlanCheckOptions): CheckPlan => {
  const targets = [...new Set(affectedWorkspacePaths)].sort();
  if (targets.some((target) => !workspacePaths.has(target))) {
    return {
      type: "fallback",
      changedPath: "invalid Turbo workspace output",
    };
  }

  const targetSet = new Set(targets);
  for (const changedPath of changedPaths) {
    const owner = workspaceForPath(changedPath);
    if (owner === null) {
      continue;
    }
    if (
      !workspacePaths.has(owner) ||
      (!targetSet.has(owner) && !invalidatesAllWorkspaceTypecheck(changedPath))
    ) {
      return { type: "fallback", changedPath };
    }
  }

  const allWorkspaceChecks = changedPaths.some(invalidatesAllWorkspaceChecks);
  const allWorkspaceTypecheck = changedPaths.some(
    invalidatesAllWorkspaceTypecheck,
  );
  const allWorkspaceLint =
    allWorkspaceChecks ||
    changedPaths.some((changedPath) =>
      LINT_ONLY_CACHE_INPUTS.some((input) =>
        matchesTurboInput(changedPath, input),
      ),
    );
  const rootCheckSet = new Set<RootCheck>([
    ROOT_CHECKS.env,
    ROOT_CHECKS.assets,
    ROOT_CHECKS.repoTypecheck,
  ]);
  for (const changedPath of changedPaths) {
    for (const rootCheck of rootChecksForPath(changedPath)) {
      rootCheckSet.add(rootCheck);
    }
  }
  const rootChecks = ROOT_CHECK_ORDER.filter((rootCheck) =>
    rootCheckSet.has(rootCheck),
  );
  const rootScriptLintRuns = rootCheckSet.has(ROOT_CHECKS.rootScriptLint);

  return {
    type: "scoped",
    lint: allWorkspaceLint ? { type: "all" } : { type: "targets", targets },
    typecheck: allWorkspaceTypecheck
      ? { type: "all" }
      : { type: "targets", targets },
    rootLintPaths: [
      ...new Set(
        presentChangedPaths.filter(
          (changedPath) =>
            workspaceForPath(changedPath) === null &&
            isChangedLintPath(changedPath) &&
            !(rootScriptLintRuns && changedPath.startsWith("scripts/")),
        ),
      ),
    ].sort(),
    rootChecks,
  };
};

type Options = {
  base: string;
  dryRun: boolean;
};

const parseArgs = (args: readonly string[]): Options => {
  let base = DEFAULT_BASE;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--base") {
      const value = args.at(index + 1);
      if (value === undefined) {
        panic("--base requires a git ref");
      }
      base = value;
      index += 1;
      continue;
    }
    panic(`Unknown argument: ${argument}`);
  }

  return { base, dryRun };
};

const run = (
  command: readonly string[],
  options: { capture?: boolean; env?: Record<string, string | undefined> } = {},
): string => {
  const capture = options.capture ?? false;
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.exitCode !== 0) {
    const output = capture ? `\n${stderr}${stdout}` : "";
    panic(`Command failed (${result.exitCode}): ${command.join(" ")}${output}`);
  }
  return stdout;
};

const workspacePaths = (): Set<string> => {
  const workspaces = new Set<string>();
  for (const parent of WORKSPACE_PARENTS) {
    for (const entry of readdirSync(path.join(REPO_ROOT, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspace = `${parent}/${entry.name}`;
      if (existsSync(path.join(REPO_ROOT, workspace, "package.json"))) {
        workspaces.add(workspace);
      }
    }
  }
  return workspaces;
};

const changedPaths = (base: string): { mergeBase: string; paths: string[] } => {
  const mergeBase = run(["git", "merge-base", base, "HEAD"], {
    capture: true,
  }).trim();
  if (mergeBase === "") {
    panic(`Could not find merge base for ${base}`);
  }
  const output = run(["git", "diff", "--name-only", "-z", mergeBase, "HEAD"], {
    capture: true,
  });
  return {
    mergeBase,
    paths: output.split("\0").filter(Boolean),
  };
};

type TurboOutput = {
  packages?: {
    items?: { path?: unknown }[];
  };
};

const affectedWorkspacePaths = (mergeBase: string): string[] => {
  const output = run(
    ["bun", "--bun", "turbo", "ls", "--affected", "--output=json"],
    {
      capture: true,
      env: {
        ...process.env,
        TURBO_SCM_BASE: mergeBase,
        TURBO_SCM_HEAD: "HEAD",
      },
    },
  );
  const jsonStart = output.indexOf("{");
  if (jsonStart === -1) {
    panic("Turbo affected output did not contain JSON");
  }
  const parsed: TurboOutput = JSON.parse(output.slice(jsonStart));
  const items = parsed.packages?.items;
  if (!Array.isArray(items)) {
    panic("Turbo affected output did not contain package items");
  }
  return items.map(({ path: workspacePath }) => {
    if (typeof workspacePath !== "string") {
      panic("Turbo affected output contained a package without a path");
    }
    return workspacePath;
  });
};

const turboCommand = (tasks: readonly string[], scope: TaskScope): string[] => [
  "bun",
  "--bun",
  "turbo",
  "run",
  ...tasks,
  "--concurrency=2",
  ...(scope.type === "all"
    ? []
    : scope.targets.map((target) => `--filter=./${target}`)),
];

const sameScope = (left: TaskScope, right: TaskScope): boolean => {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "all" || right.type === "all") {
    return true;
  }
  return (
    left.targets.length === right.targets.length &&
    left.targets.every((target, index) => target === right.targets[index])
  );
};

const hasTargets = (scope: TaskScope): boolean =>
  scope.type === "all" || scope.targets.length > 0;

export const resultBoundaryLintCommand = (
  changedFiles: readonly string[],
): string[] | null => {
  const paths = [...new Set(changedFiles)]
    .filter(isResultConventionSourceFile)
    .filter((file) => !isResultConventionExcludedFile(file))
    .filter((file) => !RESULT_BOUNDARY_BASELINE_FILES.has(file))
    .sort();
  if (paths.length === 0) {
    return null;
  }
  return [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.result-boundary.config.ts",
    "--deny-warnings",
    ...paths,
  ];
};

export const scopedCommands = (plan: ScopedCheckPlan): string[][] => {
  const commands: string[][] = [];
  const rootChecks = new Set(plan.rootChecks);
  if (rootChecks.has(ROOT_CHECKS.env)) {
    commands.push(["bun", "run", "env:check"]);
  }
  if (rootChecks.has(ROOT_CHECKS.assets)) {
    commands.push(["bun", "run", "assets:check"]);
  }
  if (rootChecks.has(ROOT_CHECKS.pluginRegistry)) {
    commands.push(["bun", "scripts/check-oxlint-plugin-registry.ts"]);
  }
  if (rootChecks.has(ROOT_CHECKS.pluginFixtures)) {
    commands.push(["bash", "scripts/lint-oxlint-fixtures.sh"]);
  }
  if (rootChecks.has(ROOT_CHECKS.rootScriptLint)) {
    commands.push(["bash", "scripts/lint-root-scripts.sh"]);
  }
  if (plan.rootLintPaths.length > 0) {
    commands.push([
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--report-unused-disable-directives-severity=error",
      "--deny-warnings",
      "--type-aware",
      ...plan.rootLintPaths,
    ]);
  }
  const lintRuns = hasTargets(plan.lint);
  const typecheckRuns = hasTargets(plan.typecheck);
  if (lintRuns && typecheckRuns && sameScope(plan.lint, plan.typecheck)) {
    commands.push(turboCommand(["lint", "typecheck"], plan.lint));
  } else {
    if (lintRuns) {
      commands.push(turboCommand(["lint"], plan.lint));
    }
    if (typecheckRuns) {
      commands.push(turboCommand(["typecheck"], plan.typecheck));
    }
  }
  if (rootChecks.has(ROOT_CHECKS.repoTypecheck)) {
    commands.push([
      "bun",
      "--bun",
      "turbo",
      "run",
      "typecheck:repo",
      "--concurrency=2",
    ]);
  }
  return commands;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const changed = changedPaths(options.base);
  const presentChangedPaths = changed.paths.filter((changedPath) =>
    existsSync(path.join(REPO_ROOT, changedPath)),
  );
  const resultBoundaryCommand = resultBoundaryLintCommand(presentChangedPaths);
  if (resultBoundaryCommand !== null) {
    process.stdout.write("code-check: exact result boundary lint\n");
    if (options.dryRun) {
      process.stdout.write(`  ${resultBoundaryCommand.join(" ")}\n`);
    } else {
      run(resultBoundaryCommand);
    }
  }
  const plan = planCheck({
    changedPaths: changed.paths,
    presentChangedPaths,
    affectedWorkspacePaths: affectedWorkspacePaths(changed.mergeBase),
    workspacePaths: workspacePaths(),
  });

  if (plan.type === "fallback") {
    process.stdout.write(
      `code-check: full repository (${plan.changedPath} requires fallback)\n`,
    );
    if (!options.dryRun) {
      run(["bun", "run", "code-check"]);
    }
    return;
  }

  const scopeLabel = (scope: TaskScope): string => {
    if (scope.type === "all") {
      return "all";
    }
    if (scope.targets.length === 0) {
      return "none";
    }
    return scope.targets.join(", ");
  };
  process.stdout.write(
    `code-check: lint ${scopeLabel(plan.lint)}; typecheck ${scopeLabel(plan.typecheck)}\n`,
  );
  const commands = scopedCommands(plan);
  if (options.dryRun) {
    for (const command of commands) {
      process.stdout.write(`  ${command.join(" ")}\n`);
    }
    return;
  }
  for (const command of commands) {
    run(command);
  }
};

if (import.meta.main) {
  main();
}
