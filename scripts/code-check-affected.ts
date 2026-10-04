#!/usr/bin/env bun

// Code-quality gate, full or affected.
//
// `--all` plans the same checks over every tracked or unignored file, so the full
// repository check and the affected check are one pass list at two scopes.
// Pre-push and pull-request CI use the affected scope, which asks Turbo for
// changed workspaces plus reverse dependants. Known global inputs widen only
// the check family they can affect, preserving independent lint and typecheck
// cache hits. Root scripts sit outside workspace tasks, so changed root
// sources are linted directly and root TypeScript projects run through a
// cacheable Turbo root task. Inconsistent affected-workspace output still
// fails safe to the full check.

import { panic } from "better-result";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  CODE_CHECK_LEGS,
  ownsCodeCheckPath,
  type CodeCheckLeg,
} from "../packages/scripts/src/code-quality-partition";
import { isChangedLintPath } from "./lint-paths";
import { measureResultBoundaryDebt } from "./ratchet";
import {
  isResultConventionExcludedFile,
  isResultConventionSourceFile,
} from "./result-boundary-globs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";
const WORKSPACE_PARENTS = ["apps", "packages"] as const;
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
// Every module `oxlint.config.ts` imports is rule configuration: a row edited
// in the ownership table, a glob in the result-boundary scope, or a file in the
// design-system backlog changes what every workspace lint reports.
// scripts/oxlint-config-inputs.test.ts holds this list to the config's imports
// and to turbo.json.
export const OXLINT_CONFIGURATION_CACHE_INPUTS = [
  "$TURBO_ROOT$/oxlint.config.ts",
  "$TURBO_ROOT$/oxlint.result-boundary.config.ts",
  "$TURBO_ROOT$/.oxlint-plugins/**",
  "$TURBO_ROOT$/scripts/oxlint-presets/**",
  "$TURBO_ROOT$/scripts/ownership.ts",
  "$TURBO_ROOT$/scripts/result-boundary-globs.ts",
  "$TURBO_ROOT$/scripts/sql-perf-detector.ts",
  "$TURBO_ROOT$/apps/api/src/db/high-volume-tables.ts",
  "$TURBO_ROOT$/apps/api/src/lib/safe-handler-factories.ts",
  "$TURBO_ROOT$/apps/api/src/lib/system-audit/modules.ts",
  "$TURBO_ROOT$/scripts/sql-perf-scope.ts",
  "$TURBO_ROOT$/scripts/design-lint-policy.ts",
  "$TURBO_ROOT$/scripts/design-lint-baseline.json",
  "$TURBO_ROOT$/scripts/source-fingerprint-baseline.json",
  "$TURBO_ROOT$/scripts/audit-mutation-ledger-scope.ts",
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
  "$TURBO_ROOT$/scripts/oxlint-typebox-unsafe.test.ts",
  "$TURBO_ROOT$/scripts/oxlint-additional-guards.test.ts",
  "$TURBO_ROOT$/scripts/check-oxlint-fixture-counts.ts",
  "$TURBO_ROOT$/scripts/check-oxlint-fixture-counts.test.ts",
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
  css: "css",
  env: "env",
  pluginFixtures: "plugin-fixtures",
  pluginRegistry: "plugin-registry",
  repoTypecheck: "repo-typecheck",
  rootScriptLint: "root-script-lint",
  ruleDecisions: "rule-decisions",
} as const;
type RootCheck = (typeof ROOT_CHECKS)[keyof typeof ROOT_CHECKS];
const ROOT_CHECK_ORDER: readonly RootCheck[] = [
  ROOT_CHECKS.env,
  ROOT_CHECKS.assets,
  ROOT_CHECKS.css,
  ROOT_CHECKS.pluginRegistry,
  ROOT_CHECKS.ruleDecisions,
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

const isTypeScriptPath = (file: string): boolean =>
  file.endsWith(".ts") ||
  file.endsWith(".tsx") ||
  file.endsWith(".mts") ||
  file.endsWith(".cts");

const rootChecksForPath = (file: string): readonly RootCheck[] => {
  const rootChecks: RootCheck[] = [];
  if (
    file.endsWith(".css") ||
    file === ".stylelintrc.json" ||
    file === ".gitignore" ||
    file === "scripts/stylelint.test.ts" ||
    DEPENDENCY_CACHE_INPUTS.some((input) => matchesTurboInput(file, input))
  ) {
    rootChecks.push(ROOT_CHECKS.css);
  }
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
  const targets = [...new Set(affectedWorkspacePaths)].toSorted();
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
    // Compares the installed Oxlint's built-in rules with the config, so a
    // dependency bump can fail it; it takes under a second.
    ROOT_CHECKS.ruleDecisions,
    ROOT_CHECKS.repoTypecheck,
  ]);
  for (const changedPath of changedPaths) {
    for (const rootCheck of rootChecksForPath(changedPath)) {
      rootCheckSet.add(rootCheck);
    }
  }
  if (
    changedPaths.some(
      (changedPath) =>
        isTypeScriptPath(changedPath) &&
        !presentChangedPaths.includes(changedPath),
    )
  ) {
    rootCheckSet.add(ROOT_CHECKS.pluginRegistry);
  }
  const rootChecks = ROOT_CHECK_ORDER.filter((rootCheck) =>
    rootCheckSet.has(rootCheck),
  );
  const rootScriptLintRuns = rootCheckSet.has(ROOT_CHECKS.rootScriptLint);
  const pluginFixturesRun = rootCheckSet.has(ROOT_CHECKS.pluginFixtures);

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
            !(rootScriptLintRuns && changedPath.startsWith("scripts/")) &&
            !(pluginFixturesRun && changedPath.startsWith(".oxlint-plugins/")),
        ),
      ),
    ].toSorted(),
    rootChecks,
  };
};

type CheckScope = { type: "all" } | { type: "affected"; base: string };

export const codeCheckExclusions = (
  workspaces: ReadonlySet<string>,
  leg: CodeCheckLeg,
): string[] =>
  [...workspaces]
    .filter((workspace) => !ownsCodeCheckPath(workspace, leg))
    .toSorted()
    .map((workspace) => `--filter=!./${workspace}`);

type Options = {
  leg?: CodeCheckLeg;
  scope: CheckScope;
  dryRun: boolean;
};

const parseArgs = (args: readonly string[]): Options => {
  let leg: CodeCheckLeg | undefined;
  let base: string | null = null;
  let all = false;
  let dryRun = false;

  const argv = args.values();
  for (const argument of argv) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--leg") {
      const value = argv.next().value;
      leg = CODE_CHECK_LEGS.find((candidate) => candidate === value);
      if (leg === undefined) {
        panic("--leg requires api, web or rest");
      }
      continue;
    }
    if (argument === "--base") {
      const value = argv.next().value;
      if (value === undefined) {
        panic("--base requires a git ref");
      }
      base = value;
      continue;
    }
    panic(`Unknown argument: ${argument}`);
  }

  if (all && base !== null) {
    panic("--all checks every tracked file and takes no --base");
  }
  return {
    ...(leg === undefined ? {} : { leg }),
    scope: all
      ? { type: "all" }
      : { type: "affected", base: base ?? DEFAULT_BASE },
    dryRun,
  };
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

const repositoryPaths = (): string[] =>
  run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    capture: true,
  })
    .split("\0")
    .filter(Boolean);

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
  debtFiles: ReadonlySet<string>,
): string[] | null => {
  const paths = [...new Set(changedFiles)]
    .filter(isResultConventionSourceFile)
    .filter((file) => !isResultConventionExcludedFile(file))
    .filter((file) => !debtFiles.has(file))
    .toSorted();
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

type PlanResultBoundaryLintOptions = {
  files: readonly string[];
  mergeBase: string | null;
  resolveMergeBase: () => string | null;
  measureDebt: (base: string) => ReadonlySet<string>;
  report: (message: string) => void;
};

export const planResultBoundaryLint = ({
  files,
  mergeBase,
  resolveMergeBase,
  measureDebt,
  report,
}: PlanResultBoundaryLintOptions): string[] | null => {
  const candidates = files
    .filter(isResultConventionSourceFile)
    .filter((file) => !isResultConventionExcludedFile(file));
  if (candidates.length === 0) {
    return null;
  }
  const base = mergeBase ?? resolveMergeBase();
  if (base === null) {
    report(
      `code-check: skipping exact result boundary lint; no merge base for ${DEFAULT_BASE} (normal lint checks still run)\n`,
    );
    return null;
  }
  return resultBoundaryLintCommand(candidates, measureDebt(base));
};

type ScopedCommandsOptions = {
  leg: CodeCheckLeg;
  workspaces: ReadonlySet<string>;
};

export const scopedCommands = (
  plan: ScopedCheckPlan,
  partition?: ScopedCommandsOptions,
): string[][] => {
  if (partition !== undefined) {
    const ownsRoot = partition.leg === "rest";
    const commands = scopedCommands({
      type: "scoped",
      lint: plan.lint,
      typecheck: plan.typecheck,
      rootLintPaths: ownsRoot ? plan.rootLintPaths : [],
      rootChecks: ownsRoot ? plan.rootChecks : [],
    });
    return commands.map((command) =>
      command[2] === "turbo" && !command.includes("typecheck:repo")
        ? command.concat(
            codeCheckExclusions(partition.workspaces, partition.leg),
          )
        : command,
    );
  }
  const commands: string[][] = [];
  const rootChecks = new Set(plan.rootChecks);
  if (rootChecks.has(ROOT_CHECKS.env)) {
    commands.push(["bun", "run", "env:check"]);
  }
  if (rootChecks.has(ROOT_CHECKS.assets)) {
    commands.push(["bun", "run", "assets:check"]);
  }
  if (rootChecks.has(ROOT_CHECKS.css)) {
    commands.push(["bun", "run", "lint:css"]);
  }
  if (rootChecks.has(ROOT_CHECKS.pluginRegistry)) {
    commands.push(["bun", "scripts/check-oxlint-plugin-registry.ts"]);
  }
  if (rootChecks.has(ROOT_CHECKS.ruleDecisions)) {
    commands.push(["bun", "scripts/check-oxlint-rule-decisions.ts"]);
  }
  if (rootChecks.has(ROOT_CHECKS.pluginFixtures)) {
    commands.push(["bash", "scripts/lint-oxlint-fixtures.sh"]);
  }
  if (rootChecks.has(ROOT_CHECKS.rootScriptLint)) {
    commands.push(["bash", "scripts/lint-root-scripts.sh"]);
  }
  if (plan.rootLintPaths.length > 0) {
    if (!rootChecks.has(ROOT_CHECKS.rootScriptLint)) {
      commands.push(["bun", "run", "generate"]);
      commands.push(["bun", "--cwd=packages/cli", "run", "codegen:runtime"]);
      commands.push(["bun", "apps/api/scripts/generate-capability-runtime.ts"]);
    }
    commands.push([
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--report-unused-disable-directives-severity=error",
      "--type-aware",
      "--type-check",
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

type FullCheckOptions = {
  files: readonly string[];
  workspacePaths: ReadonlySet<string>;
};

/**
 * The full check is the affected planner with every tracked or unignored file changed and
 * every workspace affected, so a pass added to either scope reaches both.
 * Any other outcome means a check the planner can schedule is unreachable
 * from the repository's own files.
 */
export const planFullCheck = ({
  files,
  workspacePaths: workspaces,
}: FullCheckOptions): ScopedCheckPlan => {
  const plan = planCheck({
    changedPaths: files,
    presentChangedPaths: files,
    affectedWorkspacePaths: [...workspaces],
    workspacePaths: workspaces,
  });
  if (plan.type === "fallback") {
    panic(`full code-check planned a fallback for ${plan.changedPath}`);
  }
  if (plan.lint.type !== "all" || plan.typecheck.type !== "all") {
    panic("full code-check must lint and typecheck every workspace");
  }
  const missing = ROOT_CHECK_ORDER.filter(
    (rootCheck) => !plan.rootChecks.includes(rootCheck),
  );
  if (missing.length > 0) {
    panic(`full code-check skips root checks: ${missing.join(", ")}`);
  }
  return plan;
};

const presentPaths = (paths: readonly string[]): string[] =>
  paths.filter((file) => existsSync(path.join(REPO_ROOT, file)));

type ScopeCheck = {
  plan: CheckPlan;
  presentChangedPaths: string[];
  mergeBase: string | null;
};

const planScope = (scope: CheckScope): ScopeCheck => {
  switch (scope.type) {
    case "all": {
      const files = presentPaths(repositoryPaths());
      return {
        plan: planFullCheck({
          files,
          workspacePaths: workspacePaths(),
        }),
        presentChangedPaths: files,
        mergeBase: null,
      };
    }
    case "affected": {
      const changed = changedPaths(scope.base);
      const presentChangedPaths = presentPaths(changed.paths);
      return {
        plan: planCheck({
          changedPaths: changed.paths,
          presentChangedPaths,
          affectedWorkspacePaths: affectedWorkspacePaths(changed.mergeBase),
          workspacePaths: workspacePaths(),
        }),
        presentChangedPaths,
        mergeBase: changed.mergeBase,
      };
    }
    default: {
      scope satisfies never;
      return panic("unknown code-check scope");
    }
  }
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const { plan, presentChangedPaths, mergeBase } = planScope(options.scope);
  const leg = options.leg;
  const resultBoundaryCommand = planResultBoundaryLint({
    files:
      leg === undefined
        ? presentChangedPaths
        : presentChangedPaths.filter((file) => ownsCodeCheckPath(file, leg)),
    mergeBase,
    resolveMergeBase: () => {
      const git = (args: string[]) =>
        Bun.spawnSync(["git", ...args], {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
      // Only a missing comparison ref means "no base"; any other Git failure
      // is surfaced rather than silently skipping the exact lint.
      if (
        git(["rev-parse", "--verify", "--quiet", `${DEFAULT_BASE}^{commit}`])
          .exitCode !== 0
      ) {
        return null;
      }
      const result = git(["merge-base", DEFAULT_BASE, "HEAD"]);
      const base = result.stdout.toString().trim();
      return result.exitCode === 0 && base !== ""
        ? base
        : panic(
            `git merge-base ${DEFAULT_BASE} HEAD failed: ${result.stderr.toString().trim()}`,
          );
    },
    measureDebt: measureResultBoundaryDebt,
    report: (message) => {
      process.stdout.write(message);
    },
  });
  if (resultBoundaryCommand !== null) {
    process.stdout.write("code-check: exact result boundary lint\n");
    if (options.dryRun) {
      process.stdout.write(`  ${resultBoundaryCommand.join(" ")}\n`);
    } else {
      run(resultBoundaryCommand);
    }
  }

  if (plan.type === "fallback") {
    process.stdout.write(
      `code-check: full repository (${plan.changedPath} requires fallback)\n`,
    );
    if (!options.dryRun) {
      run([
        "bun",
        "run",
        "code-check",
        ...(leg === undefined ? [] : ["--leg", leg]),
      ]);
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
  const commands = scopedCommands(
    plan,
    leg === undefined ? undefined : { leg, workspaces: workspacePaths() },
  );
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
