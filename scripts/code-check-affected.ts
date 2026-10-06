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

import { panic, Result, TaggedError } from "better-result";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

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
  "$TURBO_ROOT$/scripts/sha256-owners.ts",
  "$TURBO_ROOT$/scripts/sha256-migration-ledger.json",
  "$TURBO_ROOT$/scripts/status-write-shapes.ts",
  "$TURBO_ROOT$/scripts/parse-memo.ts",
  "$TURBO_ROOT$/apps/api/src/lib/db/status-tables.gen.ts",
  "$TURBO_ROOT$/apps/api/src/lib/lists/sanctions/monitoring-transition-identities.ts",
  "$TURBO_ROOT$/apps/api/src/lib/db/read-bounded.ts",
  "$TURBO_ROOT$/scripts/result-boundary-globs.ts",
  "$TURBO_ROOT$/scripts/sql-perf-detector.ts",
  "$TURBO_ROOT$/apps/api/src/db/high-volume-tables.ts",
  "$TURBO_ROOT$/apps/api/src/lib/safe-handler-factories.ts",
  "$TURBO_ROOT$/apps/api/src/lib/system-audit/modules.ts",
  "$TURBO_ROOT$/scripts/sql-perf-scope.ts",
  "$TURBO_ROOT$/scripts/design-lint-policy.ts",
  "$TURBO_ROOT$/scripts/design-lint-baseline.json",
  "$TURBO_ROOT$/scripts/derived-attributes.ts",
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
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    ...(env === undefined ? {} : { env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    return Result.err(
      commandFailed({
        command,
        exitCode: result.exitCode,
        output: `${stdout}\n${result.stderr.toString()}`,
      }),
    );
  }
  return Result.ok(stdout);
};

const tee = async (
  stream: ReadableStream<Uint8Array>,
  sink: NodeJS.WriteStream,
): Promise<string> => {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of stream) {
    sink.write(chunk);
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
};

// Streams the check's output live and keeps a copy, so a failure can be
// summarized from the failed task's own lines.
const runCheck = async (
  command: readonly string[],
): Promise<Result<void, CommandFailedError>> => {
  const child = Bun.spawn([...command], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    tee(child.stdout, process.stdout),
    tee(child.stderr, process.stderr),
    child.exited,
  ]);
  if (exitCode !== 0) {
    return Result.err(
      commandFailed({ command, exitCode, output: `${stdout}\n${stderr}` }),
    );
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
  ) => Result<void, CodeCheckError> | Promise<Result<void, CodeCheckError>>;
  write?: (output: string) => void;
  dryRun?: boolean;
};

export const executeCheckCommands = async ({
  commands,
  runner = runCheck,
  write = (output) => {
    process.stdout.write(output);
  },
  dryRun = false,
}: ExecuteCheckCommandsOptions): Promise<number> => {
  const failures: CodeCheckError[] = [];
  for (const command of commands) {
    if (dryRun) {
      write(`  ${command.join(" ")}\n`);
      continue;
    }
    const result = await runner(command);
    if (result.isErr()) {
      failures.push(result.error);
    }
  }
  if (failures.length === 0) {
    return 0;
  }
  write(`code-check: ${failures.length} failed command(s)\n`);
  for (const failure of failures) {
    switch (failure._tag) {
      case "CommandFailedError": {
        write(
          formatCheckFailure({
            summary: summarizeCheckFailure(failure),
            annotations: process.env["GITHUB_ACTIONS"] === "true",
          }),
        );
        break;
      }
      case "DelegatedCheckFailedError": {
        break;
      }
      default: {
        failure satisfies never;
        panic("unknown code-check failure");
      }
    }
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

const affectedWorkspacePaths = (
  mergeBase: string,
): Result<string[], CommandFailedError> =>
  capture(["bun", "--bun", "turbo", "ls", "--affected", "--output=json"], {
    ...process.env,
    TURBO_SCM_BASE: mergeBase,
    TURBO_SCM_HEAD: "HEAD",
  }).map(parseAffectedWorkspacePaths);

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

const turboCommand = (tasks: readonly string[], scope: TaskScope): string[] => [
  "bun",
  "--bun",
  "turbo",
  "run",
  ...tasks,
  "--concurrency=2",
  "--continue=dependencies-successful",
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
      commands.push(["bun", "scripts/ci-generated-sources.ts", "prepare"]);
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
      "--continue=dependencies-successful",
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

const planScope = (
  scope: CheckScope,
): Result<ScopeCheck, CommandFailedError> => {
  switch (scope.type) {
    case "all": {
      return repositoryPaths().map((paths) => {
        const files = presentPaths(paths);
        return {
          plan: planFullCheck({
            files,
            workspacePaths: workspacePaths(),
          }),
          presentChangedPaths: files,
          mergeBase: null,
        };
      });
    }
    case "affected": {
      return changedPaths(scope.base).andThen((changed) =>
        affectedWorkspacePaths(changed.mergeBase).map((affected) => {
          const presentChangedPaths = presentPaths(changed.paths);
          return {
            plan: planCheck({
              changedPaths: changed.paths,
              presentChangedPaths,
              affectedWorkspacePaths: affected,
              workspacePaths: workspacePaths(),
            }),
            presentChangedPaths,
            mergeBase: changed.mergeBase,
          };
        }),
      );
    }
    default: {
      scope satisfies never;
      return panic("unknown code-check scope");
    }
  }
};

// The full-repository fallback is another code-check run, which prints its
// own failure summary.
class DelegatedCheckFailedError extends TaggedError(
  "DelegatedCheckFailedError",
)<{
  message: string;
  exitCode: number;
}> {}

type CodeCheckError = CommandFailedError | DelegatedCheckFailedError;

const runFullFallback = (
  leg: CodeCheckLeg | undefined,
): Result<void, DelegatedCheckFailedError> => {
  const command = [
    "bun",
    "run",
    "code-check",
    ...(leg === undefined ? [] : ["--leg", leg]),
  ];
  const { exitCode } = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (exitCode !== 0) {
    return Result.err(
      new DelegatedCheckFailedError({
        message: `Command failed (${exitCode}): ${command.join(" ")}`,
        exitCode,
      }),
    );
  }
  return Result.ok();
};

const main = async (): Promise<Result<number, CommandFailedError>> => {
  const options = parseArgs(process.argv.slice(2));
  const scoped = planScope(options.scope);
  if (scoped.isErr()) {
    return scoped;
  }
  const { plan, presentChangedPaths, mergeBase } = scoped.value;
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
  const commands: string[][] = [];
  if (resultBoundaryCommand !== null) {
    process.stdout.write("code-check: exact result boundary lint\n");
    commands.push(resultBoundaryCommand);
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
        runner: async (command) =>
          command === fallbackCommand
            ? runFullFallback(leg)
            : runCheck(command),
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
  commands.push(
    ...scopedCommands(
      plan,
      leg === undefined ? undefined : { leg, workspaces: workspacePaths() },
    ),
  );
  return Result.ok(
    await executeCheckCommands({ commands, dryRun: options.dryRun }),
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
