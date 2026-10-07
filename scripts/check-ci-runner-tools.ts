/**
 * Checks optional text-tool invocations reachable from workflow Bash steps,
 * local composite actions and static shell/Python/Node/Bun script calls.
 * Computed executable/script paths and third-party action internals are outside
 * scope; script literal argv checks exclude template/f-string interpolation.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  conditionOperands,
  impliesCondition,
  lexShell,
  programWords,
} from "./install-free-ci";
import { readStringLiterals } from "./test-input-readers";
import {
  flattenWorkflowSteps,
  synchronizeWorkflowBackgroundSteps,
} from "./workflow-steps";

// This guard must run before dependencies are installed.
class RunnerToolInvariantError extends Error {
  override name = "RunnerToolInvariantError";
  readonly _tag = "RunnerToolInvariantError";
}

// Package names differ from executable names; derive every tracked executable
// and installer lookup from this table.
export const TOOL_PACKAGES = {
  rg: ["ripgrep"],
  // Debian's fd-find package exposes fdfind, not fd.
  fd: ["fd"],
  jq: ["jq"],
  yq: ["yq"],
  fzf: ["fzf"],
  sd: ["sd"],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const tracked = new Set(Object.keys(TOOL_PACKAGES));
const readYaml = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(file, "utf-8"));

// Hosted inventories promise jq; x64 Ubuntu and macOS also provide yq.
// Unknown and container images inherit no hosted-runner tools.
// https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
export const runnerTools = (
  runner: unknown,
  container: unknown,
): ReadonlySet<string> => {
  if (container !== undefined || typeof runner !== "string") {
    return new Set();
  }
  if (/^ubuntu-(?:latest|22\.04|24\.04|26\.04)$/u.test(runner)) {
    return new Set(["jq", "yq"]);
  }
  if (/^ubuntu-(?:22\.04|24\.04|26\.04)-arm$/u.test(runner)) {
    return new Set(["jq"]);
  }
  if (/^macos-(?:latest|14|15|26)(?:-large|-xlarge|-intel)?$/u.test(runner)) {
    return new Set(["jq", "yq"]);
  }
  if (/^windows-(?:latest|2022|2025)$/u.test(runner)) {
    return new Set(["jq"]);
  }
  return new Set();
};

const jobTools = (job: Record<string, unknown>) => {
  const runner = job["runs-on"];
  if (typeof runner !== "string") {
    return runnerTools(runner, job["container"]);
  }
  const axis = /^\$\{\{\s*matrix\.(\w+)\s*\}\}$/u.exec(runner)?.[1];
  if (axis === undefined) {
    return runnerTools(runner, job["container"]);
  }
  const strategy = job["strategy"];
  const matrix = isRecord(strategy) ? strategy["matrix"] : undefined;
  if (!isRecord(matrix)) {
    return new Set<string>();
  }
  const includes = Array.isArray(matrix["include"])
    ? matrix["include"].filter(isRecord)
    : [];
  const runners = Array.isArray(matrix[axis])
    ? [
        ...matrix[axis],
        ...includes
          .filter((entry) => axis in entry)
          .map((entry) => entry[axis]),
      ]
    : includes.map((entry) => entry[axis]);
  if (runners.length === 0) {
    return new Set<string>();
  }
  const profiles = runners.map((label) => runnerTools(label, job["container"]));
  return new Set(
    [...tracked].filter((tool) =>
      profiles.every((profile) => profile.has(tool)),
    ),
  );
};

// Resolve the common static event-based runner choice without assuming a
// computed/self-hosted runner shares a hosted image's installed programs.
const eventOperand = (operand: string) => {
  const match = /^github\.event_name\s*(==|!=)\s*(['"])([\w-]+)\2$/u.exec(
    operand,
  );
  if (match === null) {
    return operand;
  }
  const operator = match[1];
  const event = match[3];
  if (operator === undefined || event === undefined) {
    return operand;
  }
  return `github.event_name ${operator} '${event}'`;
};
const operands = (condition: unknown) =>
  conditionOperands(condition).map(eventOperand);
const runnerCases = (job: Record<string, unknown>) => {
  const runner = job["runs-on"];
  const match =
    typeof runner === "string"
      ? /^\$\{\{\s*(github\.event_name\s*(==|!=)\s*'([\w-]+)')\s*&&\s*(fromJSON\('([^']+)'\)|'([^']+)')\s*\|\|\s*'([^']+)'\s*\}\}$/u.exec(
          runner,
        )
      : null;
  if (match === null) {
    return [{ guaranteed: jobTools(job), condition: [] }];
  }
  const condition = match[1];
  const operator = match[2];
  const event = match[3];
  const jsonRunner = match[5];
  const plainRunner = match[6];
  const fallbackRunner = match[7];
  if (
    condition === undefined ||
    operator === undefined ||
    event === undefined ||
    (jsonRunner === undefined && plainRunner === undefined) ||
    fallbackRunner === undefined
  ) {
    return [{ guaranteed: new Set<string>(), condition: [] }];
  }
  const firstRunner: unknown =
    jsonRunner === undefined ? plainRunner : Bun.YAML.parse(jsonRunner);
  return [
    {
      guaranteed: runnerTools(firstRunner, job["container"]),
      condition: [eventOperand(condition)],
    },
    {
      guaranteed: runnerTools(fallbackRunner, job["container"]),
      condition: [
        `github.event_name ${operator === "==" ? "!=" : "=="} '${event}'`,
      ],
    },
  ];
};
const contradictoryEvents = (conditions: readonly string[]) => {
  const equal = new Set<string>();
  const unequal = new Set<string>();
  for (const operand of conditions) {
    const match = /^github\.event_name (==|!=) '([\w-]+)'$/u.exec(operand);
    if (match?.[2] === undefined) {
      continue;
    }
    (match[1] === "==" ? equal : unequal).add(match[2]);
  }
  return equal.size > 1 || [...equal].some((event) => unequal.has(event));
};

type Install = { tool: string; condition: readonly string[] };
type ScanContext = {
  root: string;
  file: string;
  cwd: string;
  label: string;
  guaranteed: ReadonlySet<string>;
  installs: Install[];
  condition: readonly string[];
  active: Set<string>;
  problems: string[];
  aliases: ReadonlyMap<string, string>;
  allowInstalls: boolean;
};

const resolveFile = (name: string, context: ScanContext) => {
  const { root, aliases } = context;
  let cwd = context.cwd;
  let candidate = name
    .replace(/\$\{\{\s*github\.workspace\s*\}\}/gu, () => root)
    .replace(/\$\{\{\s*github\.action_path\s*\}\}/gu, () =>
      path.dirname(context.file),
    )
    .replaceAll(`\${GITHUB_ACTION_PATH}`, () => path.dirname(context.file))
    .replaceAll("$GITHUB_ACTION_PATH", () => path.dirname(context.file))
    .replaceAll(`\${GITHUB_WORKSPACE}`, () => root)
    .replaceAll("$GITHUB_WORKSPACE", () => root);
  const workspacePath = path.isAbsolute(candidate);
  if (candidate.startsWith(`${root}${path.sep}`)) {
    candidate = path.relative(root, candidate);
  }
  for (const [prefix, replacement] of aliases) {
    if (cwd === prefix) {
      cwd = replacement;
    } else if (cwd.startsWith(`${prefix}/`)) {
      cwd = path.posix.join(replacement, cwd.slice(prefix.length + 1));
    }
    if (candidate.startsWith(`${prefix}/`)) {
      candidate = path.posix.join(
        replacement,
        candidate.slice(prefix.length + 1),
      );
    }
  }
  const absolute = path.resolve(root, workspacePath ? "" : cwd, candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }
  if (!existsSync(absolute)) {
    return undefined;
  }
  const actual = realpathSync(absolute);
  return actual.startsWith(`${root}${path.sep}`) ? actual : undefined;
};

const toolInstalled = (
  tool: string,
  { guaranteed, installs, condition }: ScanContext,
) =>
  guaranteed.has(tool) ||
  installs.some(
    (install) =>
      install.tool === tool &&
      impliesCondition({ install: install.condition, step: condition }),
  );

// Keep original offsets so argv matching can inspect literals while rejecting
// subprocess-looking text in Python comments, strings and docstrings.
const pythonCodePositions = (source: string) => {
  const positions = new Uint8Array(source.length);
  let index = 0;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === "#") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === "'" || character === '"') {
      const triple = character.repeat(3);
      const delimiter = source.startsWith(triple, index) ? triple : character;
      index += delimiter.length;
      while (index < source.length) {
        if (source.charAt(index) === "\\") {
          index += 2;
          continue;
        }
        if (source.startsWith(delimiter, index)) {
          index += delimiter.length;
          break;
        }
        index += 1;
      }
      continue;
    }
    positions[index] = 1;
    index += 1;
  }
  return positions;
};

const inspectSource = (file: string, context: ScanContext) => {
  if (context.active.has(file)) {
    return;
  }
  if (!statSync(file).isFile()) {
    return;
  }
  const source = readFileSync(file, "utf-8");
  const interpreter =
    /^#!\s*(?:\S*\/)?(?:env\s+(?:-S\s+)?)?(python[\d.]*|bash|sh)(?:\s|$)/u.exec(
      source,
    )?.[1];
  const python =
    file.endsWith(".py") || interpreter?.startsWith("python") === true;
  const javascript = /\.[cm]?[jt]s$/u.test(file);
  if (
    !python &&
    !javascript &&
    !file.endsWith(".sh") &&
    interpreter === undefined
  ) {
    return;
  }
  context.active.add(file);
  const child = { ...context, file };
  if (python || javascript) {
    // Literal subprocess argv preserves executable identity across languages.
    const executables: string[] = [];
    if (python) {
      const code = pythonCodePositions(source);
      for (const match of source.matchAll(
        /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*\[\s*["']([^"']+)["']/gu,
      )) {
        const executable = match[1];
        if (code[match.index] === 1 && executable !== undefined) {
          executables.push(executable);
        }
      }
    } else {
      readStringLiterals(source, (callee, argumentsSource) => {
        if (!/^(?:spawn(?:Sync)?|execFile(?:Sync)?)$/u.test(callee ?? "")) {
          return;
        }
        const executable = /^\(\s*(?:\[\s*)?["']([^"']+)["']/u.exec(
          argumentsSource,
        )?.[1];
        if (executable !== undefined) {
          executables.push(executable);
        }
      });
    }
    for (const executable of executables) {
      const command = path.basename(executable);
      if (tracked.has(command) && !toolInstalled(command, context)) {
        context.problems.push(
          `${context.label}: ${path.relative(context.root, file)} requires ${command}, which this runner/job does not provide`,
        );
      }
    }
  } else {
    inspectShell(source, child);
  }
  context.active.delete(file);
};

const unwrapShellCommand = (input: readonly string[]) => {
  let words = programWords(input);
  if (words.at(0) === "sudo") {
    words = words.slice(1);
    while (words.at(0)?.startsWith("-") === true) {
      const option = words.at(0);
      if (option === "--") {
        words = words.slice(1);
        break;
      }
      if (
        [
          "--help",
          "-V",
          "--version",
          "-v",
          "--validate",
          "-l",
          "--list",
          "-K",
          "--remove-timestamp",
        ].includes(option ?? "")
      ) {
        words = [];
        break;
      }
      const takesArgument = [
        "-u",
        "--user",
        "-g",
        "--group",
        "-h",
        "--host",
        "-p",
        "--prompt",
        "-C",
        "--close-from",
        "-D",
        "--chdir",
        "-R",
        "--chroot",
        "-T",
        "--command-timeout",
        "-a",
        "--auth-type",
      ].includes(option ?? "");
      words = words.slice(takesArgument ? 2 : 1);
    }
    words = programWords(words);
  }
  if (words.at(0) === "command") {
    words = words.slice(1);
    if (/^-[p]*[vV]/u.test(words.at(0) ?? "")) {
      return [];
    }
    while (words.at(0) === "-p" || words.at(0) === "--") {
      words = words.slice(1);
    }
    if (/^-[p]*[vV]/u.test(words.at(0) ?? "")) {
      return [];
    }
  } else if (words.at(0) === "builtin") {
    words = words.slice(1);
  }
  return words;
};

const installedTools = (words: readonly string[]) => {
  const command = path.basename(words.at(0) ?? "");
  let operation: string;
  let preview: RegExp;
  switch (command) {
    case "apt":
    case "apt-get":
      operation = "install";
      preview =
        /^(?:--(?:download-only|simulate|dry-run|just-print|recon|no-act|print-uris)(?:=|$)|-[^-]*[ds])/u;
      break;
    case "apk":
      operation = "add";
      preview = /^(?:--simulate(?:=|$)|-[^-]*s)/u;
      break;
    case "brew":
      operation = "install";
      preview = /^--dry-run$/u;
      break;
    default:
      return [];
  }
  if (words.at(1) !== operation || words.some((word) => preview.test(word))) {
    return [];
  }
  return Object.entries(TOOL_PACKAGES)
    .filter(([, packages]) => packages.some((pkg) => words.includes(pkg)))
    .map(([tool]) => tool);
};

type ShellInvocation =
  | { type: "skip" }
  | { type: "code"; source: string }
  | { type: "script"; file: string | undefined };
const shellInvocation = (words: readonly string[]): ShellInvocation => {
  let optionIndex = 1;
  let syntaxOnly = false;
  let codeIndex = -1;
  while (words.at(optionIndex)?.startsWith("-") === true) {
    const option = words.at(optionIndex) ?? "";
    if (option === "--") {
      break;
    }
    if (/^-[^-]*n/u.test(option)) {
      syntaxOnly = true;
    }
    if (/^-[^-]*c/u.test(option)) {
      codeIndex = optionIndex + 1;
      break;
    }
    optionIndex += /^-[^-]*[oO]$/u.test(option) ? 2 : 1;
  }
  if (syntaxOnly) {
    return { type: "skip" };
  }
  if (codeIndex !== -1) {
    const code = words.at(codeIndex);
    if (code === undefined) {
      return { type: "skip" };
    }
    return { type: "code", source: code };
  }
  return {
    type: "script",
    file: words.at(
      words.at(optionIndex) === "--" ? optionIndex + 1 : optionIndex,
    ),
  };
};

const SCRIPT_INTERPRETERS = new Set([
  "python3",
  "python",
  "bun",
  "node",
  "source",
  ".",
]);
type InspectInvocationOptions = {
  words: readonly string[];
  stdin: string | undefined;
  directories: ReadonlySet<string>;
  context: ScanContext;
};
const inspectInvocation = ({
  words,
  stdin,
  directories,
  context,
}: InspectInvocationOptions) => {
  const command = path.basename(words.at(0) ?? "");
  let script: string | undefined;
  if (command === "bash" || command === "sh") {
    const invocation = shellInvocation(words);
    switch (invocation.type) {
      case "skip":
        return;
      case "code":
        for (const cwd of directories) {
          inspectShell(invocation.source, { ...context, cwd });
        }
        return;
      case "script":
        script = invocation.file;
        break;
      default: {
        invocation satisfies never;
        throw new RunnerToolInvariantError(
          `Unhandled shell invocation: ${String(invocation)}`,
        );
      }
    }
    if (stdin !== undefined) {
      for (const cwd of directories) {
        inspectShell(stdin, { ...context, cwd });
      }
    }
  } else if (SCRIPT_INTERPRETERS.has(command)) {
    const argumentsStart = command === "bun" && words.at(1) === "run" ? 2 : 1;
    script = words.slice(argumentsStart).find((word) => !word.startsWith("-"));
  } else {
    script = words.at(0);
  }
  if (script === undefined) {
    return;
  }
  for (const cwd of directories) {
    const owner = { ...context, cwd };
    const file = resolveFile(script, owner);
    if (file !== undefined) {
      inspectSource(file, owner);
    }
  }
};

const inspectShell = (source: string, context: ScanContext) => {
  const events = lexShell(source);
  let conditional =
    !context.allowInstalls ||
    events.some((event) => event.type === "control-flow");
  let directories = new Set([context.cwd]);
  for (const event of events) {
    switch (event.type) {
      case "control-flow":
      case "subshell-start":
      case "subshell-end":
        // A branch/subshell install cannot guarantee a later invocation.
        conditional = true;
        continue;
      case "unparsed":
        context.problems.push(
          `${context.label}: cannot inspect shell: ${event.reason}`,
        );
        continue;
      case "command":
        break;
      default: {
        event satisfies never;
        throw new RunnerToolInvariantError(
          `Unhandled shell event: ${String(event)}`,
        );
      }
    }
    const words = unwrapShellCommand(event.words);
    const rawCommand = words.at(0);
    if (rawCommand === undefined) {
      continue;
    }
    const command = path.basename(rawCommand);
    const child = { ...context, allowInstalls: !conditional };
    if (command === "cd") {
      const changed = [...directories].flatMap((cwd) => {
        const directory = resolveFile(words.at(1) ?? "$HOME", {
          ...child,
          cwd,
        });
        return directory === undefined
          ? []
          : [path.relative(context.root, directory)];
      });
      if (changed.length > 0) {
        directories = new Set(
          conditional ? [...directories, ...changed] : changed,
        );
      }
      continue;
    }
    if (tracked.has(command) && !toolInstalled(command, context)) {
      context.problems.push(
        `${context.label}: ${path.relative(context.root, context.file)} requires ${command}, which this runner/job does not provide`,
      );
    }
    if (!conditional) {
      for (const tool of installedTools(words)) {
        context.installs.push({ tool, condition: context.condition });
      }
    }
    inspectInvocation({
      words,
      stdin: event.stdin?.body,
      directories,
      context: child,
    });
  }
};

type StepExecutionOptions = {
  step: Record<string, unknown>;
  jobDefaults: Record<string, unknown>;
  workflowDefaults: Record<string, unknown>;
  labelPrefix: string;
  index: number;
};
const stepExecution = ({
  step,
  jobDefaults,
  workflowDefaults,
  labelPrefix,
  index,
}: StepExecutionOptions):
  | { problem: string }
  | { label: string; cwd: string; shell: string } => {
  const stepName = step["name"];
  const id = step["id"];
  if (stepName !== undefined && typeof stepName !== "string") {
    return { problem: `${labelPrefix}${index}: name must be a string` };
  }
  if (id !== undefined && typeof id !== "string") {
    return { problem: `${labelPrefix}${index}: id must be a string` };
  }
  const label = `${labelPrefix}${stepName ?? id ?? index}`;
  const configuredDirectory = [
    step["working-directory"],
    jobDefaults["working-directory"],
    workflowDefaults["working-directory"],
  ].find((value) => value !== undefined);
  const cwd = configuredDirectory === undefined ? "" : configuredDirectory;
  const configuredShell = [
    step["shell"],
    jobDefaults["shell"],
    workflowDefaults["shell"],
  ].find((value) => value !== undefined);
  const shell = configuredShell === undefined ? "bash" : configuredShell;
  if (typeof cwd !== "string") {
    return { problem: `${label}: working-directory must be a string` };
  }
  if (typeof shell !== "string") {
    return { problem: `${label}: shell must be a string` };
  }
  return { label, cwd, shell };
};

type RunnerStepContext = {
  readonly root: string;
  readonly workflow: string;
  readonly jobName: string;
  readonly jobDefaults: Record<string, unknown>;
  readonly workflowDefaults: Record<string, unknown>;
  readonly guaranteed: ReadonlySet<string>;
  readonly active: Set<string>;
  readonly problems: string[];
  readonly aliases: ReadonlyMap<string, string>;
};

type WalkRunnerStepsOptions = {
  readonly context: RunnerStepContext;
  readonly entries: unknown[];
  readonly prefix: string;
  readonly parent: readonly string[];
  readonly owner: string;
  readonly availableInstalls: Install[];
  readonly availablePending: Map<string, Install[]>;
};

type DeferRunnerBackgroundInstallsOptions = {
  step: Record<string, unknown>;
  installStart: number;
  availableInstalls: Install[];
  availablePending: Map<string, Install[]>;
};
const deferRunnerBackgroundInstalls = ({
  step,
  installStart,
  availableInstalls,
  availablePending,
}: DeferRunnerBackgroundInstallsOptions) => {
  if (step["background"] !== true) {
    return;
  }
  const added = availableInstalls.splice(installStart);
  if (typeof step["id"] !== "string") {
    return;
  }
  const records = availablePending.get(step["id"]);
  if (records === undefined) {
    availablePending.set(step["id"], added);
  } else {
    records.push(...added);
  }
};

const walkRunnerSteps = ({
  context: state,
  entries,
  prefix,
  parent,
  owner,
  availableInstalls,
  availablePending,
}: WalkRunnerStepsOptions) => {
  const {
    root,
    workflow,
    jobName,
    jobDefaults,
    workflowDefaults,
    guaranteed,
    active,
    problems,
    aliases,
  } = state;
  for (const [index, step] of entries.entries()) {
    if (!isRecord(step)) {
      continue;
    }
    const completed = synchronizeWorkflowBackgroundSteps(
      step,
      availablePending,
    );
    if (completed !== undefined) {
      availableInstalls.push(...completed);
      continue;
    }
    if ("parallel" in step) {
      if (
        Object.keys(step).some((key) => key !== "parallel") ||
        !Array.isArray(step["parallel"])
      ) {
        problems.push(
          `${workflow}/${jobName}/${prefix}${index}: malformed parallel workflow step`,
        );
        continue;
      }
      walkRunnerParallelSteps({
        siblings: step["parallel"],
        context: state,
        prefix: `${prefix}parallel-${index}/`,
        parent,
        owner,
        availableInstalls,
        availablePending,
      });
      continue;
    }
    const execution = stepExecution({
      step,
      jobDefaults,
      workflowDefaults,
      labelPrefix: `${workflow}/${jobName}/${prefix}`,
      index,
    });
    if ("problem" in execution) {
      problems.push(execution.problem);
      continue;
    }
    const { label, cwd, shell } = execution;
    const installStart = availableInstalls.length;
    const scanContext = {
      root,
      file: owner,
      cwd,
      label,
      guaranteed,
      installs: availableInstalls,
      condition: [...parent, ...operands(step["if"])],
      active,
      problems,
      aliases,
      allowInstalls: true,
    };
    if (contradictoryEvents(scanContext.condition)) {
      continue;
    }
    if (
      typeof step["run"] === "string" &&
      !/^(?:pwsh|powershell|python)/u.test(shell)
    ) {
      const before = availableInstalls.length;
      inspectShell(step["run"], scanContext);
      if (
        step["continue-on-error"] !== undefined &&
        step["continue-on-error"] !== false
      ) {
        availableInstalls.splice(before);
      }
    }
    if (typeof step["run"] === "string") {
      deferRunnerBackgroundInstalls({
        step,
        installStart,
        availableInstalls,
        availablePending,
      });
    }
    if (typeof step["uses"] !== "string" || !step["uses"].startsWith("./")) {
      continue;
    }
    const actionDirectory = resolveFile(step["uses"], {
      ...scanContext,
      cwd: "",
    });
    if (actionDirectory === undefined) {
      deferRunnerBackgroundInstalls({
        step,
        installStart,
        availableInstalls,
        availablePending,
      });
      continue;
    }
    const actionFile = ["action.yml", "action.yaml"]
      .map((name) => path.join(actionDirectory, name))
      .find(existsSync);
    if (actionFile === undefined) {
      deferRunnerBackgroundInstalls({
        step,
        installStart,
        availableInstalls,
        availablePending,
      });
      continue;
    }
    const action = readYaml(actionFile);
    if (
      isRecord(action) &&
      isRecord(action["runs"]) &&
      action["runs"]["using"] === "composite" &&
      Array.isArray(action["runs"]["steps"])
    ) {
      if (active.has(actionFile)) {
        problems.push(`${label}: recursive composite action ${step["uses"]}`);
        deferRunnerBackgroundInstalls({
          step,
          installStart,
          availableInstalls,
          availablePending,
        });
        continue;
      }
      const before = availableInstalls.length;
      active.add(actionFile);
      walkRunnerSteps({
        context: state,
        entries: action["runs"]["steps"],
        prefix: `${prefix}${step["uses"]}/`,
        parent: scanContext.condition,
        owner: actionFile,
        availableInstalls: scanContext.installs,
        availablePending,
      });
      active.delete(actionFile);
      if (
        step["continue-on-error"] !== undefined &&
        step["continue-on-error"] !== false
      ) {
        availableInstalls.splice(before);
      }
    }
    deferRunnerBackgroundInstalls({
      step,
      installStart,
      availableInstalls,
      availablePending,
    });
  }
};

type WalkRunnerParallelStepsOptions = {
  readonly siblings: readonly unknown[];
  readonly context: RunnerStepContext;
  readonly prefix: string;
  readonly parent: readonly string[];
  readonly owner: string;
  readonly availableInstalls: Install[];
  readonly availablePending: Map<string, Install[]>;
};

const walkRunnerParallelSteps = ({
  siblings,
  context,
  prefix,
  parent,
  owner,
  availableInstalls,
  availablePending,
}: WalkRunnerParallelStepsOptions) => {
  const before = availableInstalls.length;
  const pendingBefore = new Map(
    [...availablePending].map(([id, records]) => [id, records.length]),
  );
  const additions: Install[] = [];
  for (const sibling of siblings) {
    const branch = [...availableInstalls];
    const branchPending = new Map(
      [...availablePending].map(([id, records]) => [id, [...records]]),
    );
    walkRunnerSteps({
      context,
      entries: [sibling],
      prefix,
      parent,
      owner,
      availableInstalls: branch,
      availablePending: branchPending,
    });
    additions.push(...branch.slice(before));
    for (const [id, records] of branchPending) {
      const priorCount = pendingBefore.get(id) ?? 0;
      if (records.length > priorCount) {
        additions.push(...records.slice(priorCount));
      }
    }
  }
  availableInstalls.push(...additions);
};

type RunnerToolProblemsOptions = {
  root: string;
  workflow: string;
  repository: string;
};
export const runnerToolProblems = ({
  root: inputRoot,
  workflow,
  repository,
}: RunnerToolProblemsOptions): string[] => {
  const root = realpathSync(inputRoot);
  const source = readYaml(path.join(root, workflow));
  if (!isRecord(source) || !isRecord(source["jobs"])) {
    return [`${workflow}: expected workflow jobs`];
  }
  const problems: string[] = [];
  for (const [jobName, job] of Object.entries(source["jobs"])) {
    if (!isRecord(job) || !Array.isArray(job["steps"])) {
      continue;
    }
    const aliases = new Map<string, string>();
    const steps = job["steps"];
    for (const step of flattenWorkflowSteps(steps)) {
      const inputs = step["with"];
      if (
        typeof step["uses"] !== "string" ||
        !step["uses"].startsWith("actions/checkout@") ||
        !isRecord(inputs)
      ) {
        continue;
      }
      if (
        typeof inputs["path"] === "string" &&
        (inputs["repository"] === undefined ||
          inputs["repository"] === repository ||
          inputs["repository"] === `\${{ github.repository }}`)
      ) {
        aliases.set(inputs["path"], "");
      }
    }
    for (const runnerCase of runnerCases(job)) {
      const guaranteed = runnerCase.guaranteed;
      const installs: Install[] = [];
      const pending = new Map<string, Install[]>();
      const active = new Set<string>();
      const workflowDefaults =
        isRecord(source["defaults"]) && isRecord(source["defaults"]["run"])
          ? source["defaults"]["run"]
          : {};
      const jobDefaults =
        isRecord(job["defaults"]) && isRecord(job["defaults"]["run"])
          ? job["defaults"]["run"]
          : {};
      walkRunnerSteps({
        context: {
          root,
          workflow,
          jobName,
          jobDefaults,
          workflowDefaults,
          guaranteed,
          active,
          problems,
          aliases,
        },
        entries: steps,
        prefix: "",
        parent: [...runnerCase.condition, ...operands(job["if"])],
        owner: path.join(root, workflow),
        availableInstalls: installs,
        availablePending: pending,
      });
    }
  }
  return [...new Set(problems)];
};

if (import.meta.main) {
  const root = path.resolve(process.argv.at(2) ?? ".");
  const repository = process.argv.at(3) ?? process.env["GITHUB_REPOSITORY"];
  if (repository === undefined) {
    console.error(
      "Usage: bun check-ci-runner-tools.ts <checkout> <owner/repository>",
    );
    process.exit(1);
  }
  const problems = [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ].flatMap((workflow) => runnerToolProblems({ root, workflow, repository }));
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(
    "CI runner tools: every inspected invocation has a runner or same-job installation contract.",
  );
}
