#!/usr/bin/env bun

// Code-quality gate, full or affected.
//
// `--all` plans the same checks over every tracked or unignored file, so the full
// repository check and the affected check are one pass list at two scopes.
// Pre-push and pull-request CI use the affected scope, which asks Turbo for
// changed workspaces plus reverse dependants. Known global inputs widen only
// the check family they can affect, preserving independent lint and typecheck
// cache hits. Root scripts sit outside workspace tasks, so changed root
// sources are linted directly (every root source when a lint-wide input
// changes, as in the full check) and root TypeScript projects run through a
// cacheable Turbo root task. Inconsistent affected-workspace output still
// fails safe to the full check.

import { panic, Result, TaggedError } from "better-result";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import {
  CODE_CHECK_LEGS,
  type CodeCheckLeg,
  ownsCodeCheckPath,
} from "../packages/scripts/src/code-quality-partition";
import { RUST_TEST_DISCOVERY_INPUTS } from "./check-rust-test-determinism";
import { runBudgetedCheck, TASK_STALL_MS } from "./code-quality-task-budget";
import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };
import { isChangedLintPath } from "./lint-paths";
import { matches } from "./oxlint-config-scopes";
import { measureResultBoundaryDebt } from "./ratchet";
import {
  isResultConventionExcludedFile,
  isResultConventionSourceFile,
} from "./result-boundary-globs";
import {
  isRootScriptLintPath,
  rootTypeAwareLintCommand,
} from "./root-script-lint";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";
// API lint and typecheck run in parallel after generation. Allow the slower
// branch, two generator stages and a minute for planning/cleanup.
export const CODE_CHECK_EXECUTION_BUDGET_MS =
  (Math.max(
    configuredBudgets.overrides["@stll/api#typecheck"],
    configuredBudgets.overrides["@stll/api#lint"],
  ) +
    configuredBudgets.defaultSeconds * 2 +
    60) *
  1000;
// Completed planning-phase bounds include Git and module startup as well as Turbo.
const PLANNING_COMMAND_BUDGET_MS =
  Math.ceil(
    Math.max(...configuredBudgets.planningPhaseUpperBoundsSeconds) * 2 + 30,
  ) * 1000;
export const planningCommandTimeout = (
  remainingMs = PLANNING_COMMAND_BUDGET_MS,
) => Math.max(1, Math.min(PLANNING_COMMAND_BUDGET_MS, remainingMs));
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
  // Turbo hashes each workspace's resolved lock graph and root tools itself.
  ...DEPENDENCY_CACHE_INPUTS.filter(
    (input) =>
      input !== "$TURBO_ROOT$/bun.lock" &&
      input !== "$TURBO_ROOT$/package.json",
  ),
  ...SHARED_COMPILER_CACHE_INPUTS,
] as const;
// Turbo hashes each workspace's resolved dependencies. Root programs span
// multiple workspaces and still need the complete lockfile in their inputs.
export const WORKSPACE_TYPECHECK_CACHE_INPUTS = [
  ...ALL_WORKSPACE_CACHE_INPUTS,
  "$TURBO_ROOT$/package.json",
] as const;
// Every entry here can change lint output outside its owning workspace: a row
// edited in the ownership table, a glob in the result-boundary scope, or a file
// in the design-system backlog changes what multiple workspace lints report.
// Workspace-local files that the config imports belong to that workspace's
// `$TURBO_DEFAULT$` inputs instead; merely evaluating the config does not make
// their contents an input to unrelated lint scopes.
// scripts/oxlint-config-inputs.test.ts holds this list to the config's imports
// and to turbo.json.
export const OXLINT_CONFIGURATION_CACHE_INPUTS = [
  "$TURBO_ROOT$/oxlint.config.ts",
  "$TURBO_ROOT$/oxlint.result-boundary.config.ts",
  "$TURBO_ROOT$/.oxlint-plugins/**",
  "$TURBO_ROOT$/scripts/oxlint-presets/**",
  "$TURBO_ROOT$/scripts/ownership.ts",
  "$TURBO_ROOT$/scripts/ownership/*.ts",
  "$TURBO_ROOT$/scripts/ownership-loader.ts",
  "$TURBO_ROOT$/scripts/ownership-types.ts",
  "$TURBO_ROOT$/scripts/sha256-owners.ts",
  "$TURBO_ROOT$/scripts/sha256-migration-ledger.json",
  "$TURBO_ROOT$/scripts/status-write-shapes.ts",
  "$TURBO_ROOT$/scripts/oxlint-disable-rule-ids.ts",
  "$TURBO_ROOT$/scripts/oxlint-rule-ids.ts",
  "$TURBO_ROOT$/apps/api/src/lib/lists/sanctions/monitoring-transition-identities.ts",
  "$TURBO_ROOT$/apps/api/src/lib/db/read-bounded.ts",
  "$TURBO_ROOT$/scripts/result-boundary-globs.ts",
  "$TURBO_ROOT$/scripts/sql-perf-detector.ts",
  "$TURBO_ROOT$/apps/api/src/db/high-volume-tables.ts",
  "$TURBO_ROOT$/apps/api/src/lib/db/public-corpus-audit/**",
  "$TURBO_ROOT$/apps/api/src/lib/safe-handler-factories.ts",
  "$TURBO_ROOT$/apps/api/src/lib/system-audit/modules.ts",
  "$TURBO_ROOT$/scripts/sql-perf-scope.ts",
  "$TURBO_ROOT$/scripts/design-lint-policy.ts",
  "$TURBO_ROOT$/scripts/design-lint-baseline.json",
  "$TURBO_ROOT$/scripts/derived-attributes.ts",
  "$TURBO_ROOT$/scripts/source-fingerprint-baseline.json",
  "$TURBO_ROOT$/scripts/audit-mutation-ledger-scope.ts",
  "$TURBO_ROOT$/scripts/test-state-baseline.json",
  "$TURBO_ROOT$/scripts/check-test-state-baseline.ts",
  "$TURBO_ROOT$/scripts/baseline-paths.ts",
  "$TURBO_ROOT$/scripts/ledger-membership.ts",
  "$TURBO_ROOT$/scripts/product-frontend-files.ts",
  "$TURBO_ROOT$/.claude/mcp/doc-sources.ts",
  "$TURBO_ROOT$/packages/api-contract/src/case-law-text-field.ts",
  "$TURBO_ROOT$/packages/auth-model/src/contract.ts",
  "$TURBO_ROOT$/packages/errors/src/query-field-policy.ts",
  "$TURBO_ROOT$/packages/portable-path/src/index.ts",
  "$TURBO_ROOT$/packages/scripts/src/child-exit-status.ts",
  "$TURBO_ROOT$/packages/scripts/src/generated-artifact-format.ts",
  "$TURBO_ROOT$/packages/scripts/src/syntax-tree.ts",
  "$TURBO_ROOT$/packages/sha256/src/node.ts",
  "$TURBO_ROOT$/scripts/aggregate-lock-baseline.json",
  "$TURBO_ROOT$/scripts/calendar-day-ledger.json",
  "$TURBO_ROOT$/scripts/contract-domain-ledger.ts",
  "$TURBO_ROOT$/scripts/fill-diagnostics-ledger.json",
  "$TURBO_ROOT$/scripts/generated-artifacts.ts",
  "$TURBO_ROOT$/scripts/oxlint-config-scopes.ts",
  "$TURBO_ROOT$/scripts/parser-validator-call-ledger.json",
  "$TURBO_ROOT$/scripts/swallowed-item-error-ledger.json",
  "$TURBO_ROOT$/scripts/tailwind-lint-cache.ts",
  "$TURBO_ROOT$/scripts/test-timing-ledger.json",
] as const;
export const LINT_ONLY_CACHE_INPUTS = [
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/tsconfig.tooling.json",
] as const;
export const PLUGIN_FIXTURE_INPUTS = [
  ...Object.values(RUST_TEST_DISCOVERY_INPUTS).map(
    (input) => `$TURBO_ROOT$/${input}`,
  ),
  "$TURBO_ROOT$/scripts/check-rust-test-determinism.ts",
  "$TURBO_ROOT$/scripts/rust-test-determinism-scan.ts",
  "$TURBO_ROOT$/scripts/check-rust-test-determinism.test.ts",
  "$TURBO_ROOT$/scripts/rust-test-determinism-baseline.json",
  ...DEPENDENCY_CACHE_INPUTS,
  ...SHARED_COMPILER_CACHE_INPUTS,
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/scripts/lint-oxlint-fixtures.sh",
  "$TURBO_ROOT$/scripts/oxlint-safe-fixers.test.ts",
  "$TURBO_ROOT$/scripts/oxlint-additional-guards.test.ts",
  "$TURBO_ROOT$/scripts/check-oxlint-fixture-counts.ts",
  "$TURBO_ROOT$/scripts/check-oxlint-fixture-counts.test.ts",
  // The status-column map the no-direct-status-set fixture is linted against;
  // it stays a fixture input although it no longer forces lint everywhere.
  "$TURBO_ROOT$/apps/api/src/lib/db/status-tables.gen.ts",
  "$TURBO_ROOT$/tsconfig.json",
  "$TURBO_ROOT$/tsconfig.oxlint-plugins.json",
] as const;
export const PLUGIN_REGISTRY_INPUTS = [
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/scripts/check-oxlint-plugin-registry.ts",
] as const;
export const ROOT_SCRIPT_LINT_INPUTS = [
  ...DEPENDENCY_CACHE_INPUTS,
  ...SHARED_COMPILER_CACHE_INPUTS,
  ...OXLINT_CONFIGURATION_CACHE_INPUTS,
  "$TURBO_ROOT$/scripts/lint-root-scripts.sh",
  "$TURBO_ROOT$/scripts/lint-root-scripts.ts",
  "$TURBO_ROOT$/scripts/root-script-lint.ts",
  "$TURBO_ROOT$/scripts/tsconfig.json",
  "$TURBO_ROOT$/tsconfig.scripts.json",
] as const;
// Inputs that change what the root lint reports for a root source the pull
// request does not touch. When one changes, the affected check lints every
// root lint path, as the full check does, so a rule or config change cannot
// pass its pull request and then fail the full check on main. Root scripts and
// rule sources stay with the root-script-lint and plugin-fixtures checks,
// whose own inputs cover them.
const ROOT_LINT_INPUTS = [
  ...DEPENDENCY_CACHE_INPUTS,
  ...SHARED_COMPILER_CACHE_INPUTS,
  ...LINT_ONLY_CACHE_INPUTS,
] as const;
const TURBO_CONFIG_PATH = "turbo.json";
const TURBO_ROOT_INPUT_PREFIX = "$TURBO_ROOT$/";

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
  /**
   * The tracked or unignored files present in the checkout. Only root paths
   * are read, so a caller may leave out the workspace files.
   */
  repositoryPaths: readonly string[];
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
  return matches(relativeInput, file);
};

export const matchedLintAllInputs = (
  changedPaths: readonly string[],
): string[] =>
  [...ALL_WORKSPACE_CACHE_INPUTS, ...LINT_ONLY_CACHE_INPUTS].filter((input) =>
    changedPaths.some((changedPath) => matchesTurboInput(changedPath, input)),
  );

export const lintAllTrace = (
  changedPaths: readonly string[],
): string | null => {
  const matchedInputs = matchedLintAllInputs(changedPaths);
  return matchedInputs.length === 0
    ? null
    : `code-check: lint all shared inputs: ${matchedInputs.join(", ")}\n`;
};

const invalidatesAllWorkspaceChecks = (file: string): boolean =>
  file === TURBO_CONFIG_PATH ||
  ALL_WORKSPACE_CACHE_INPUTS.some((input) => matchesTurboInput(file, input));

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
  repositoryPaths,
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
      (!targetSet.has(owner) && !invalidatesAllWorkspaceChecks(changedPath))
    ) {
      return { type: "fallback", changedPath };
    }
  }

  const allWorkspaceChecks = changedPaths.some(invalidatesAllWorkspaceChecks);
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
  const rootLintCandidates = changedPaths.some((changedPath) =>
    ROOT_LINT_INPUTS.some((input) => matchesTurboInput(changedPath, input)),
  )
    ? [
        ...presentChangedPaths,
        ...repositoryPaths.filter(
          (file) =>
            !file.startsWith("scripts/") &&
            !file.startsWith(".oxlint-plugins/"),
        ),
      ]
    : presentChangedPaths;

  return {
    type: "scoped",
    lint: allWorkspaceLint ? { type: "all" } : { type: "targets", targets },
    typecheck: allWorkspaceChecks
      ? { type: "all" }
      : { type: "targets", targets },
    rootLintPaths: [
      ...new Set(
        rootLintCandidates.filter(
          (changedPath) =>
            workspaceForPath(changedPath) === null &&
            (changedPath.startsWith("scripts/")
              ? isRootScriptLintPath(changedPath)
              : isChangedLintPath(changedPath)) &&
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
  /** Pre-push leaves a change that needs the full check to CI. */
  skipFullFallback: boolean;
};

const parseArgs = (args: readonly string[]): Options => {
  let leg: CodeCheckLeg | undefined;
  let base: string | null = null;
  let all = false;
  let dryRun = false;
  let skipFullFallback = false;

  const argv = args.values();
  for (const argument of argv) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--skip-full-fallback") {
      skipFullFallback = true;
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
    skipFullFallback,
  };
};

export class CommandFailedError extends TaggedError("CommandFailedError")<{
  message: string;
  command: readonly string[];
  exitCode: number;
  output: string;
}> {}

type CommandFailure = {
  command: readonly string[];
  exitCode: number;
  output: string;
};

const commandFailed = (failure: CommandFailure): CommandFailedError =>
  new CommandFailedError({
    message: `Command failed (${failure.exitCode}): ${failure.command.join(" ")}`,
    ...failure,
  });

const capture = (
  command: readonly string[],
  env?: Record<string, string | undefined>,
): Result<string, CommandFailedError> => {
  const timeoutMs = planningCommandTimeout();
  const startedAt = Date.now();
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    ...(env === undefined ? {} : { env }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout.toString();
  const exitCode = childExitStatus(result);
  const diagnostic = `code-check: planner ${command.join(" ")} elapsed=${Date.now() - startedAt}ms budget=${timeoutMs}ms exit=${exitCode} signal=${String(result.signalCode ?? "none")}\n`;
  process.stdout.write(diagnostic);
  if (exitCode !== 0) {
    return Result.err(
      commandFailed({
        command,
        exitCode,
        output: `${diagnostic}${stdout}\n${result.stderr.toString()}`,
      }),
    );
  }
  return Result.ok(stdout);
};

// Streams the check's output live and keeps a copy, so a failure can be
// summarized from the failed task's own lines.
const runCheck = async (
  command: readonly string[],
  timeoutMs = CODE_CHECK_EXECUTION_BUDGET_MS,
): Promise<Result<void, CommandFailedError>> => {
  const { exitCode, output } = await runBudgetedCheck({
    command,
    cwd: REPO_ROOT,
    timeoutMs,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    writeSummary: (text) => {
      const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
      if (summaryPath !== undefined) {
        appendFileSync(summaryPath, text);
      }
    },
  });
  if (exitCode !== 0) {
    return Result.err(commandFailed({ command, exitCode, output }));
  }
  return Result.ok();
};

type FailedTask = { task: string; errors: string[] };

type CheckFailureSummary = {
  command: string;
  exitCode: number;
  tasks: FailedTask[];
};

const TURBO_FAILED_TASKS = /^\s*Failed:\s+(?<tasks>\S.*)$/u;
const TURBO_RUN_SUMMARY = /^\s*Tasks:\s+\d+ successful/u;
const GROUP_START = /^::group::(?<task>.+)$/u;
const GROUP_END = "::endgroup::";
const STACK_FRAME = /^\s*at\s|node_modules\/|\.bun\/install\/cache\//u;
const EXIT_NOISE = /exited \(\d+\)|exited with code \d+/u;
const ERROR_LINE =
  /error TS\d+|^::error\b|^##\[error\]|^\s*[x×!] [\w@/.-]+\([\w@/.-]+\): |^\s*,-\[[^\]]+\]$|^error\b|^Found \d+ warnings? and \d+ errors?/u;
const ANNOTATION = /^::error(?: (?<properties>[^:]*))?::(?<message>.*)$/u;
const ANNOTATION_TITLE = /(?:^|,)title=(?<title>[^,]*)/u;
const MAX_ERROR_LINES = 20;
const FALLBACK_TAIL_LINES = 10;

const decodeAnnotation = (value: string): string =>
  value
    .replaceAll("%2C", ",")
    .replaceAll("%3A", ":")
    .replaceAll("%0A", " ")
    .replaceAll("%0D", "")
    .replaceAll("%25", "%");

// A tool's own GitHub annotation reads as "title: message" in the summary.
const readableErrorLine = (line: string): string => {
  const annotation = ANNOTATION.exec(line)?.groups;
  if (annotation === undefined) {
    return line.trim();
  }
  const message = decodeAnnotation(annotation["message"] ?? "");
  const title = ANNOTATION_TITLE.exec(annotation["properties"] ?? "")?.groups?.[
    "title"
  ];
  return title === undefined
    ? message
    : `${decodeAnnotation(title)}: ${message}`;
};

const errorLines = (lines: readonly string[]): string[] => {
  const meaningful = lines.filter(
    (line) =>
      line.trim() !== "" && !STACK_FRAME.test(line) && !EXIT_NOISE.test(line),
  );
  const matched = meaningful.filter((line) => ERROR_LINE.test(line));
  const picked = (
    matched.length > 0 ? matched : meaningful.slice(-FALLBACK_TAIL_LINES)
  ).map(readableErrorLine);
  if (picked.length <= MAX_ERROR_LINES) {
    return picked;
  }
  return [
    ...picked.slice(0, MAX_ERROR_LINES),
    `... ${picked.length - MAX_ERROR_LINES} more error lines above`,
  ];
};

/**
 * Names each failed Turbo task with its own error lines. Turbo prefixes task
 * output with `<package>:<task>: ` locally and puts it under a task header on
 * GitHub Actions; both shapes attribute lines to a task. A command that is not
 * a Turbo run is its own single task.
 */
export const summarizeCheckFailure = ({
  command,
  exitCode,
  output,
}: CommandFailedError): CheckFailureSummary => {
  const commandText = command.join(" ");
  const lines = stripVTControlCharacters(output).split(/\r?\n/u);
  const failedTasks = lines.flatMap(
    (line) =>
      TURBO_FAILED_TASKS.exec(line)
        ?.groups?.["tasks"]?.split(",")
        .map((task) => task.trim())
        .filter(Boolean) ?? [],
  );
  if (failedTasks.length === 0) {
    return {
      command: commandText,
      exitCode,
      tasks: [{ task: commandText, errors: errorLines(lines) }],
    };
  }

  // Turbo reports `<package>#<task>` but labels output `<package>:<task>`.
  const taskByLabel = new Map(
    failedTasks.map((task) => [task.replace("#", ":"), task]),
  );
  const taskLines = new Map<string, string[]>();
  for (const task of failedTasks) {
    taskLines.set(task, []);
  }
  let current: string | undefined;
  for (const line of lines) {
    if (line === GROUP_END || TURBO_RUN_SUMMARY.test(line)) {
      current = undefined;
      continue;
    }
    const header = GROUP_START.exec(line)?.groups?.["task"] ?? line.trim();
    if (taskByLabel.has(header) || GROUP_START.test(line)) {
      current = taskByLabel.get(header);
      continue;
    }
    const prefixed = [...taskByLabel].find(([label]) =>
      line.startsWith(`${label}:`),
    );
    if (prefixed !== undefined) {
      const [label, task] = prefixed;
      taskLines.get(task)?.push(line.slice(label.length + 1).trimStart());
      continue;
    }
    if (current !== undefined) {
      taskLines.get(current)?.push(line);
    }
  }
  return {
    command: commandText,
    exitCode,
    tasks: failedTasks.map((task) => ({
      task,
      errors: errorLines(taskLines.get(task) ?? []),
    })),
  };
};

const escapeAnnotationData = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeAnnotationProperty = (value: string): string =>
  escapeAnnotationData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

type FormatCheckFailureOptions = {
  summary: CheckFailureSummary;
  annotations: boolean;
};

export const formatCheckFailure = ({
  summary,
  annotations,
}: FormatCheckFailureOptions): string => {
  const lines = [
    "",
    `code-check: failed (exit ${summary.exitCode}): ${summary.command}`,
  ];
  for (const { task, errors } of summary.tasks) {
    lines.push(`  ${task}`, ...errors.map((error) => `    ${error}`));
  }
  if (annotations) {
    for (const { task, errors } of summary.tasks) {
      lines.push(
        `::error title=${escapeAnnotationProperty(`code-check: ${task} failed`)}::${escapeAnnotationData(errors.join("\n"))}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

type ExecuteCheckCommandsOptions = {
  commands: readonly (readonly string[])[];
  runner?: (
    command: readonly string[],
    timeoutMs: number,
  ) => Result<void, CodeCheckError> | Promise<Result<void, CodeCheckError>>;
  write?: (output: string) => void;
  dryRun?: boolean;
  budgetDeadlineMs?: number;
  now?: () => number;
};

export const executeCheckCommands = async ({
  commands,
  runner,
  write = (output) => {
    process.stdout.write(output);
  },
  dryRun = false,
  now = Date.now,
  budgetDeadlineMs = now() + CODE_CHECK_EXECUTION_BUDGET_MS,
}: ExecuteCheckCommandsOptions): Promise<number> => {
  const failures: CodeCheckError[] = [];
  let warned = false;
  for (const command of commands) {
    if (dryRun) {
      write(`  ${command.join(" ")}\n`);
      continue;
    }
    const timeoutMs = Math.max(0, budgetDeadlineMs - now());
    if (timeoutMs === 0 && !warned) {
      warned = true;
      write(
        "::warning title=task-budget::code-check execution warning budget exceeded; continuing checks\n",
      );
    }
    const result = await (runner === undefined
      ? runCheck(command, timeoutMs)
      : runner(command, timeoutMs));
    if (result.isErr()) {
      failures.push(result.error);
      break;
    }
  }
  if (failures.length === 0) {
    return 0;
  }
  write(`code-check: ${failures.length} failed command(s)\n`);
  for (const failure of failures) {
    // The nested full check already printed its task diagnostics.
    if (
      failure.command[0] === "bun" &&
      failure.command[1] === "run" &&
      failure.command[2] === "code-check"
    ) {
      write(
        `code-check: delegated full check failed (exit ${failure.exitCode}): ${failure.command.join(" ")}\n`,
      );
      continue;
    }
    write(
      formatCheckFailure({
        summary: summarizeCheckFailure(failure),
        annotations: process.env["GITHUB_ACTIONS"] === "true",
      }),
    );
  }
  return 1;
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

const repositoryPaths = (): Result<string[], CommandFailedError> =>
  capture([
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]).map((output) => output.split("\0").filter(Boolean));

type ChangedPaths = { mergeBase: string; paths: string[] };

const changedPaths = (base: string): Result<ChangedPaths, CommandFailedError> =>
  capture(["git", "merge-base", base, "HEAD"]).andThen((output) => {
    const mergeBase = output.trim();
    if (mergeBase === "") {
      panic(`Could not find merge base for ${base}`);
    }
    return capture(["git", "diff", "--name-only", "-z", mergeBase, "HEAD"]).map(
      (diff) => ({
        mergeBase,
        paths: diff.split("\0").filter(Boolean),
      }),
    );
  });

type TurboOutput = {
  packages?: {
    items?: { path?: unknown }[];
  };
};

type AffectedWorkspaceDiscovery =
  { type: "scoped"; paths: string[] } | { type: "fallback"; reason: string };
type DiscoverAffectedWorkspacesOptions = {
  mergeBase: string;
  command?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  stallMs?: number;
  report?: (diagnostic: string) => void;
};

export const discoverAffectedWorkspaces = async ({
  mergeBase,
  command = ["bun", "--bun", "turbo", "ls", "--affected", "--output=json"],
  cwd = REPO_ROOT,
  timeoutMs = planningCommandTimeout(),
  stallMs = TASK_STALL_MS,
  report = (diagnostic) => {
    process.stdout.write(diagnostic);
  },
}: DiscoverAffectedWorkspacesOptions): Promise<
  Result<AffectedWorkspaceDiscovery, CommandFailedError>
> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const startedAt = Date.now();
  const result = await runBudgetedCheck({
    command,
    cwd,
    timeoutMs,
    stallMs,
    summary: "none",
    env: { TURBO_SCM_BASE: mergeBase, TURBO_SCM_HEAD: "HEAD" },
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
    writeSummary: (markdown) => {
      stderr.push(markdown);
    },
  });
  const diagnostic = `code-check: planner ${command.join(" ")} elapsed=${Date.now() - startedAt}ms budget=${timeoutMs}ms exit=${result.exitCode} outcome=${result.outcome}\n`;
  report(diagnostic);
  if (result.outcome === "stalled") {
    report(
      `${stderr.join("")}code-check: affected planner stalled; using full check scope\n`,
    );
    return Result.ok({
      type: "fallback",
      reason: "affected workspace planner stall",
    });
  }
  if (result.exitCode !== 0) {
    return Result.err(
      commandFailed({
        command,
        exitCode: result.exitCode,
        output: diagnostic + result.output,
      }),
    );
  }
  return Result.ok({
    type: "scoped",
    paths: parseAffectedWorkspacePaths(stdout.join("")),
  });
};

const parseAffectedWorkspacePaths = (output: string): string[] => {
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

const THREE_TASK_MEMORY_BYTES = 12 * 1024 ** 3;
const CGROUP_ROOT = "/sys/fs/cgroup";

type CgroupMount = { version: 1 | 2; root: string; mountpoint: string };

/**
 * cgroup mounts from /proc/self/mountinfo: v2, and v1 hierarchies carrying
 * the memory controller (alone or combined, wherever they are mounted).
 */
export const cgroupMounts = (mountinfo: string): CgroupMount[] =>
  mountinfo.split("\n").flatMap((line): CgroupMount[] => {
    const [mounted, filesystem] = line.split(" - ");
    const fields = mounted?.split(" ") ?? [];
    const [type, , options] = filesystem?.split(" ") ?? [];
    const root = fields[3];
    const mountpoint = fields[4];
    if (root === undefined || mountpoint === undefined) {
      return [];
    }
    if (type === "cgroup2") {
      return [{ version: 2 as const, root, mountpoint }];
    }
    if (type === "cgroup" && options?.split(",").includes("memory")) {
      return [{ version: 1 as const, root, mountpoint }];
    }
    return [];
  });

/**
 * Memory-limit files for this process's cgroup and every ancestor, v2 then
 * v1. A nested cgroup can be limited while the mount root reports `max`. A
 * cgroup path maps through its mount (its root and mount point), so a v1
 * memory controller mounted elsewhere or combined with others still counts.
 */
export const cgroupMemoryLimitFiles = (
  procSelfCgroup: string,
  mountinfo = "",
): string[] => {
  const files: string[] = [];
  const mounts = cgroupMounts(mountinfo);
  const mountsFor = (version: 1 | 2): CgroupMount[] => {
    const found = mounts.filter((mount) => mount.version === version);
    if (found.length > 0) {
      return found;
    }
    // Without mount information, assume the conventional layout.
    return [
      {
        version,
        root: "/",
        mountpoint: version === 2 ? CGROUP_ROOT : `${CGROUP_ROOT}/memory`,
      },
    ];
  };
  const mountRelative = (cgroupPath: string, root: string) => {
    if (cgroupPath === root || cgroupPath.startsWith(`${root}/`)) {
      return cgroupPath.slice(root.length);
    }
    // Inside a cgroup namespace the path is relative to the namespace root,
    // which is the root of a mount inherited with its host path.
    return cgroupPath;
  };
  const ancestry = (cgroupPath: string) => {
    const parts = cgroupPath.split("/").filter((part) => part !== "");
    return parts.map(
      (_, index) => `/${parts.slice(0, parts.length - index).join("/")}`,
    );
  };
  for (const line of procSelfCgroup.split("\n")) {
    const [, controllers, cgroupPath] = line.split(":");
    if (controllers === undefined || cgroupPath === undefined) {
      continue;
    }
    const memoryV1 = controllers.split(",").includes("memory");
    if (controllers !== "" && !memoryV1) {
      continue;
    }
    const version = controllers === "" ? 2 : 1;
    const file = version === 2 ? "memory.max" : "memory.limit_in_bytes";
    for (const mount of mountsFor(version)) {
      const inside = mountRelative(cgroupPath, mount.root);
      files.push(
        ...ancestry(inside).map((dir) => `${mount.mountpoint}${dir}/${file}`),
        // The mount root: a namespaced container sees its own cgroup there.
        `${mount.mountpoint}/${file}`,
      );
    }
  }
  files.push(
    `${CGROUP_ROOT}/memory.max`,
    `${CGROUP_ROOT}/memory/memory.limit_in_bytes`,
  );
  return [...new Set(files)];
};

/**
 * The memory the checks may use: the machine's, or a lower container limit.
 * A cloud sandbox reports its host's memory through `totalmem()` while its
 * cgroup enforces far less.
 */
export const memoryLimitBytes = ({
  total = totalmem(),
  read = (file: string) =>
    existsSync(file) ? readFileSync(file, "utf-8") : undefined,
  requested = process.env["CODE_CHECK_MEMORY_BYTES"],
}: {
  total?: number;
  read?: (file: string) => string | undefined;
  requested?: string | undefined;
} = {}): number => {
  // An explicit byte count replaces detection (tests pin the plan with it).
  const override = Number(requested);
  if (
    requested !== undefined &&
    Number.isSafeInteger(override) &&
    override > 0
  ) {
    return override;
  }
  let limit = total;
  const selfCgroup =
    Result.try(() => read("/proc/self/cgroup")).unwrapOr(undefined) ?? "";
  const mountinfo =
    Result.try(() => read("/proc/self/mountinfo")).unwrapOr(undefined) ?? "";
  for (const file of cgroupMemoryLimitFiles(selfCgroup, mountinfo)) {
    const value = Number(
      Result.try(() => read(file))
        .unwrapOr(undefined)
        ?.trim() ?? Number.NaN,
    );
    if (Number.isSafeInteger(value) && value > 0) {
      limit = Math.min(limit, value);
    }
  }
  return limit;
};

// Type-aware API lint (about 14 GiB resident on a cold run) and the API
// typecheck each need most of a small machine; together they push a 16 GiB
// sandbox into its memory limit and stall for many minutes.
const SEPARATE_API_CHECKS_BELOW_BYTES = 24 * 1024 ** 3;
const API_FILTER = "--filter=./apps/api";

/**
 * Below 24 GiB, a Turbo command that runs both lint and typecheck over the
 * API runs typecheck and then lint, so the two API programs never share the
 * memory. Other commands, and larger machines, keep lint and typecheck
 * overlapped.
 */
export const separateApiLintFromTypecheck = (
  commands: readonly string[][],
  memoryBytes: number,
): string[][] =>
  commands.flatMap((command) => {
    if (
      memoryBytes >= SEPARATE_API_CHECKS_BELOW_BYTES ||
      command[2] !== "turbo"
    ) {
      return [command];
    }
    const lintAt = command.indexOf("lint");
    const typecheckAt = command.indexOf("typecheck");
    if (lintAt === -1 || typecheckAt === -1) {
      return [command];
    }
    const targets = command.filter((argument) =>
      argument.startsWith("--filter=./"),
    );
    const coversApi =
      !command.includes("--filter=!./apps/api") &&
      (targets.length === 0 || targets.includes(API_FILTER));
    if (!coversApi) {
      return [command];
    }
    return [
      command.filter((_, index) => index !== lintAt),
      command.filter((_, index) => index !== typecheckAt),
    ];
  });
/** Memory-based task count; a valid request may only lower it. */
export const codeCheckConcurrency = (
  memoryBytes: number,
  requested?: string,
): number => {
  const memoryDefault = memoryBytes >= THREE_TASK_MEMORY_BYTES ? 3 : 2;
  const override = Number(requested);
  if (
    requested !== undefined &&
    Number.isSafeInteger(override) &&
    override > 0
  ) {
    return Math.min(override, memoryDefault);
  }
  return memoryDefault;
};

// CODE_CHECK_CONCURRENCY lowers the task count on a busy host (pre-push runs
// one task at a time); child Turbo runs inherit it.
export const configuredCodeCheckConcurrency = (): number =>
  codeCheckConcurrency(
    memoryLimitBytes(),
    process.env["CODE_CHECK_CONCURRENCY"],
  );

const turboCommand = (tasks: readonly string[], scope: TaskScope): string[] => [
  "bun",
  "--bun",
  "turbo",
  "run",
  ...tasks,
  `--concurrency=${configuredCodeCheckConcurrency()}`,
  "--summarize",
  "--remote-cache-timeout=20",
  "--log-order=stream",
  "--log-prefix=task",
  ...(scope.type === "all"
    ? []
    : scope.targets.map((target) => `--filter=./${target}`)),
];

export const prioritizeWebLint = (commands: string[][]): string[][] =>
  commands.flatMap((command) => {
    if (
      command[2] !== "turbo" ||
      !command.includes("lint") ||
      command.includes("--filter=!./apps/web") ||
      (command.some((argument) => argument.startsWith("--filter=./")) &&
        !command.includes("--filter=./apps/web"))
    ) {
      return [command];
    }
    // Explicit task IDs start the critical web program before the smaller
    // workspaces. Its generated prerequisites still run through Turbo.
    const web = [
      ...turboCommand(
        command.includes("typecheck")
          ? ["@stll/web#lint", "@stll/web#typecheck"]
          : ["@stll/web#lint"],
        { type: "all" },
      ),
    ];
    return [web, [...command, "--filter=!./apps/web"]];
  });

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
    const partitioned = commands.map((command) =>
      command[2] === "turbo" && !command.includes("typecheck:repo")
        ? command.concat(
            codeCheckExclusions(partition.workspaces, partition.leg),
          )
        : command,
    );
    return partition.leg === "web"
      ? prioritizeWebLint(partitioned)
      : partitioned;
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
      commands.push(["bun", "scripts/ci-generated-sources.ts", "prepare"]);
    }
    commands.push(rootTypeAwareLintCommand(plan.rootLintPaths));
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
      `--concurrency=${configuredCodeCheckConcurrency()}`,
      "--summarize",
      "--remote-cache-timeout=20",
      "--log-order=stream",
      "--log-prefix=task",
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
    repositoryPaths: files,
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
  changedPaths: string[];
  presentChangedPaths: string[];
  mergeBase: string | null;
};

const planScope = async (
  scope: CheckScope,
): Promise<Result<ScopeCheck, CommandFailedError>> => {
  switch (scope.type) {
    case "all": {
      return repositoryPaths().map((paths) => {
        const files = presentPaths(paths);
        return {
          plan: planFullCheck({
            files,
            workspacePaths: workspacePaths(),
          }),
          changedPaths: paths,
          presentChangedPaths: files,
          mergeBase: null,
        };
      });
    }
    case "affected": {
      const changed = changedPaths(scope.base);
      if (changed.isErr()) {
        return changed;
      }
      const repository = repositoryPaths();
      if (repository.isErr()) {
        return repository;
      }
      const affected = await discoverAffectedWorkspaces({
        mergeBase: changed.value.mergeBase,
      });
      return affected.map((discovery) => {
        const presentChangedPaths = presentPaths(changed.value.paths);
        return {
          plan:
            discovery.type === "fallback"
              ? { type: "fallback", changedPath: discovery.reason }
              : planCheck({
                  changedPaths: changed.value.paths,
                  presentChangedPaths,
                  repositoryPaths: presentPaths(
                    repository.value.filter(
                      (file) => workspaceForPath(file) === null,
                    ),
                  ),
                  affectedWorkspacePaths: discovery.paths,
                  workspacePaths: workspacePaths(),
                }),
          changedPaths: changed.value.paths,
          presentChangedPaths,
          mergeBase: changed.value.mergeBase,
        };
      });
    }
    default: {
      scope satisfies never;
      return panic("unknown code-check scope");
    }
  }
};

type CodeCheckError = CommandFailedError;

const main = async (): Promise<Result<number, CommandFailedError>> => {
  const budgetDeadlineMs = Date.now() + CODE_CHECK_EXECUTION_BUDGET_MS;
  const options = parseArgs(process.argv.slice(2));
  // Verify the narrow runtime pin before even the Turbo affected/dry-run query:
  // a stale projection must fail before any old-runtime cache can be replayed.
  const toolchain = await runCheck(
    ["bun", "scripts/generate-bun-toolchain.ts"],
    Math.min(30_000, Math.max(0, budgetDeadlineMs - Date.now())),
  );
  if (toolchain.isErr()) {
    return toolchain;
  }
  const scoped = await planScope(options.scope);
  if (scoped.isErr()) {
    return scoped;
  }
  const {
    plan,
    changedPaths: selectedChangedPaths,
    presentChangedPaths,
    mergeBase,
  } = scoped.value;
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
          timeout: planningCommandTimeout(budgetDeadlineMs - Date.now()),
          killSignal: "SIGKILL",
        });
      // Only a missing comparison ref means "no base"; any other Git failure
      // is surfaced rather than silently skipping the exact lint.
      const reference = git([
        "rev-parse",
        "--verify",
        "--quiet",
        `${DEFAULT_BASE}^{commit}`,
      ]);
      const terminated = Boolean(reference.signalCode);
      if (reference.exitCode === 1 && !terminated) {
        return null;
      }
      if (childExitStatus(reference) !== 0) {
        panic(
          `git rev-parse ${DEFAULT_BASE} failed: ${reference.stderr.toString().trim()}`,
        );
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
  const commands: string[][] = [];
  if (resultBoundaryCommand !== null) {
    process.stdout.write("code-check: exact result boundary lint\n");
    commands.push(resultBoundaryCommand);
  }

  if (plan.type === "fallback" && options.skipFullFallback) {
    process.stdout.write(
      `code-check: skipped; ${plan.changedPath} requires the full repository check, which CI runs\n`,
    );
    return Result.ok(
      await executeCheckCommands({
        commands,
        dryRun: options.dryRun,
        budgetDeadlineMs,
      }),
    );
  }
  if (plan.type === "fallback") {
    process.stdout.write(
      `code-check: full repository (${plan.changedPath} requires fallback)\n`,
    );
    const fallbackCommand = [
      "bun",
      "run",
      "code-check",
      ...(leg === undefined ? [] : ["--leg", leg]),
    ];
    commands.push(fallbackCommand);
    return Result.ok(
      await executeCheckCommands({
        commands,
        dryRun: options.dryRun,
        budgetDeadlineMs,
      }),
    );
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
  if (plan.lint.type === "all") {
    const trace = lintAllTrace(selectedChangedPaths);
    if (trace !== null) {
      process.stdout.write(trace);
    }
  }
  commands.push(
    ...scopedCommands(
      plan,
      leg === undefined ? undefined : { leg, workspaces: workspacePaths() },
    ),
  );
  return Result.ok(
    await executeCheckCommands({
      commands: separateApiLintFromTypecheck(commands, memoryLimitBytes()),
      dryRun: options.dryRun,
      budgetDeadlineMs,
    }),
  );
};

/**
 * A failed check must never exit 0: a signal-terminated child can report a
 * missing or zero code, which would turn the failure into a pass.
 */
export const failureExitCode = (code: number | null | undefined) =>
  code !== null &&
  code !== undefined &&
  Number.isInteger(code) &&
  code > 0 &&
  code < 256
    ? code
    : 1;

if (import.meta.main) {
  const result = await main();
  if (result.isErr()) {
    process.stdout.write(
      formatCheckFailure({
        summary: summarizeCheckFailure(result.error),
        annotations: process.env["GITHUB_ACTIONS"] === "true",
      }),
    );
    process.exit(failureExitCode(result.error.exitCode));
  }
  process.exitCode = result.value;
}
