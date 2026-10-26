#!/usr/bin/env bun

// Runs every test under scripts/ that no CI workflow step names.
//
// Root script tests are not a workspace package, so no `turbo run test` ever
// reaches them; each runs only where a workflow step calls it by path. A test
// added without that step never ran: the Dockerfile entrypoint guard sat
// orphaned while the gap it exists to catch shipped. The steps that do name a
// test stay where they are, since several are placed to run before or without
// the dependency install. This run takes the remainder, so the set of tests CI
// executes is derived from the directory rather than kept by hand.
//
//   bun scripts/run-unlisted-script-tests.ts

import { panic } from "better-result";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { buildImportGraph } from "./api-test-impact";
import { readCiCheckCommandText } from "./ci-check-pool-registry";
import { changedFilesSince, comparisonBase } from "./ci-comparison-base";
import scriptTestInputs from "./script-test-inputs.json" with { type: "json" };

const declaredInputs = new Map(Object.entries(scriptTestInputs.inputs));

type ScriptTestArguments =
  | { readonly type: "valid"; readonly timeout: number | undefined }
  | { readonly type: "invalid"; readonly message: string };

export const parseScriptTestArguments = (
  args: readonly string[],
): ScriptTestArguments => {
  let timeout: number | undefined;
  const argumentsIterator = args.values();
  for (const argument of argumentsIterator) {
    if (argument !== "--timeout") {
      return { type: "invalid", message: `unknown argument: ${argument}` };
    }
    if (timeout !== undefined) {
      return { type: "invalid", message: "--timeout may be supplied once" };
    }
    const raw = argumentsIterator.next().value;
    if (typeof raw !== "string" || !/^\d+$/u.test(raw)) {
      return {
        type: "invalid",
        message: "--timeout requires a positive integer",
      };
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return {
        type: "invalid",
        message: "--timeout requires a positive integer",
      };
    }
    timeout = parsed;
  }
  return { type: "valid", timeout };
};

type UnlistedTestCommandOptions = {
  readonly files: readonly string[];
  readonly timeout: number | undefined;
  /** Bun processes the test files are spread over; they run at once. */
  readonly groups?: number;
  /** A file's expected cost (its size); the heaviest are placed first. */
  readonly weightOf?: (file: string) => number;
};

/**
 * `files` spread over at most `groups` lists, heaviest first onto the
 * lightest list, so each list costs about the same. Ties break by path, so
 * the split is the same on every run.
 */
export const balanceTestFiles = (
  files: readonly string[],
  groups: number,
  weightOf: (file: string) => number,
): string[][] => {
  const lists = Array.from(
    { length: Math.max(1, Math.min(groups, files.length)) },
    () => ({ files: [] as string[], weight: 0 }),
  );
  const ordered = files
    .map((file) => ({ file, weight: weightOf(file) }))
    .toSorted((a, b) => {
      if (a.weight !== b.weight) {
        return b.weight - a.weight;
      }
      // Repository paths, compared by code unit: the order only has to be
      // stable, not linguistic.
      if (a.file === b.file) {
        return 0;
      }
      return a.file < b.file ? -1 : 1;
    });
  for (const { file, weight } of ordered) {
    let lightest = lists[0] ?? panic("A balance has a group");
    for (const list of lists) {
      if (list.weight < lightest.weight) {
        lightest = list;
      }
    }
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return lists
    .map((list) => list.files.toSorted())
    .filter((list) => list.length > 0);
};

export const unlistedTestCommands = ({
  files,
  timeout,
  groups = 1,
  weightOf = () => 1,
}: UnlistedTestCommandOptions): string[][] => {
  const bunTests = files.filter((file) => file.endsWith(".ts"));
  const shellTests = files.filter((file) => file.endsWith(".sh"));
  return [
    ...balanceTestFiles(bunTests, groups, weightOf).map((group) => [
      "bun",
      "test",
      ...(timeout === undefined ? [] : ["--timeout", String(timeout)]),
      ...group,
    ]),
    ...shellTests.map((file) => ["bash", file]),
  ];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const APT_TIMEOUT_MS = 180_000;
/** Install strace on a CI runner, through the repository's retry owner. */
const installStrace = () => {
  const started = performance.now();
  for (const args of [
    ["sudo", "apt-get", "update", "-qq"],
    [
      "sudo",
      "apt-get",
      "install",
      "-y",
      "-qq",
      "--no-install-recommends",
      "strace",
    ],
  ]) {
    const installed = Bun.spawnSync(
      ["bash", path.join(REPO_ROOT, "scripts/retry.sh"), ...args],
      { stdout: "inherit", stderr: "inherit", timeout: APT_TIMEOUT_MS },
    );
    if (installed.exitCode !== 0) {
      panic(`Installing strace failed: ${args.join(" ")}`);
    }
  }
  console.log(
    `Installed strace in ${((performance.now() - started) / 1000).toFixed(1)} s.`,
  );
};

export const prepareStrace = ({
  ci,
  selectedTests,
  available,
  install = installStrace,
}: {
  readonly ci: boolean;
  readonly selectedTests: number;
  readonly available: () => boolean;
  readonly install?: () => void;
}): boolean => {
  if (ci && selectedTests > 0 && !available()) {
    install();
  }
  const installed = available();
  if (ci && selectedTests > 0 && !installed) {
    panic(
      "strace is required in CI; install it with: sudo apt-get install strace",
    );
  }
  return installed;
};
const TEST_GLOB = "scripts/**/*.test.{ts,sh}";
const RUNNER_PATH = "scripts/run-unlisted-script-tests.ts";
export const SCAN_PRELOAD_PATH = "scripts/script-test-scan-preload.ts";

/**
 * Files a traced test may open without declaring them: its own import
 * closure and the runner's instrumentation (the scan preload Bun loads into
 * every test, with everything it imports).
 */
export const tracedAllowance = (
  closure: (file: string) => ReadonlySet<string>,
  testFile: string,
): ReadonlySet<string> =>
  new Set([...closure(testFile), ...closure(SCAN_PRELOAD_PATH)]);

const SCRIPT_TEST_ALL_RULES = {
  manifest: /(?:^|\/)package\.json$/u,
  lockfile: /(?:^|\/)bun\.lockb?$/u,
  typescript: /(?:^|\/)tsconfig[^/]*\.json$/u,
  bun: /(?:^|\/)bunfig\.toml$/u,
} as const;

type ScriptTestSelection = {
  readonly files: string[];
  readonly skipped: number;
  readonly reason?: string;
};

type SelectScriptTestsOptions = {
  readonly tests: readonly string[];
  readonly changed: readonly string[];
  readonly root?: string;
  readonly inputs?: Readonly<Record<string, readonly string[]>>;
  readonly exemptions?: Readonly<Record<string, string>>;
  /** Tracked files; a closure file outside it is generated output. */
  readonly tracked?: ReadonlySet<string>;
};

const trackedFiles = (): Set<string> => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    panic("Could not list tracked repository files");
  }
  return new Set(result.stdout.toString().split("\0").filter(Boolean));
};

/** Select tests only when HEAD proves their code or declared data changed. */
export const selectScriptTests = ({
  tests,
  changed,
  root = REPO_ROOT,
  inputs = scriptTestInputs.inputs,
  exemptions = scriptTestInputs.noTrackedInputs,
  tracked = root === REPO_ROOT ? trackedFiles() : undefined,
}: SelectScriptTestsOptions): ScriptTestSelection => {
  const realRoot = realpathSync(root);
  const graph = buildImportGraph(realRoot, [
    ...tests.filter((test) => test.endsWith(".ts")),
    RUNNER_PATH,
    SCAN_PRELOAD_PATH,
  ]);
  // Every test runs with the scan preload, which the runner names but does
  // not import.
  const runnerClosure = new Set([
    ...graph.closure(RUNNER_PATH),
    ...graph.closure(SCAN_PRELOAD_PATH),
  ]);
  if (
    changed.some(
      (file) =>
        runnerClosure.has(file) ||
        Object.values(SCRIPT_TEST_ALL_RULES).some((rule) => rule.test(file)),
    )
  ) {
    return {
      files: [...tests],
      skipped: 0,
      reason: "shared test configuration or runner changed",
    };
  }
  const undeclared = tests.filter((test) => {
    const closure = graph.closure(test);
    return (
      [...closure].some(
        (file) => graph.readers.has(file) || graph.scanners.has(file),
      ) &&
      (!Object.hasOwn(inputs, test) || inputs[test]?.length === 0) &&
      !Object.hasOwn(exemptions, test)
    );
  });
  // Generated sources exist only where CI prepared them, and no tracked file
  // digest covers their generators' inputs. A test reaching one, or an import
  // that cannot resolve, can never be proven unaffected, so it declares `**`.
  const runsAlways = (test: string) => inputs[test]?.includes("**") === true;
  const unresolved = tests.filter(
    (test) =>
      !runsAlways(test) &&
      [...graph.closure(test)].some(
        (file) =>
          graph.failed.has(file) ||
          (tracked !== undefined && !tracked.has(file)),
      ),
  );
  if (undeclared.length > 0 || unresolved.length > 0) {
    panic(
      [
        undeclared.length > 0
          ? `Script tests with undeclared data inputs: ${undeclared.join(", ")}`
          : "",
        unresolved.length > 0
          ? `Script tests with unresolved or generated imports (declare "**"): ${unresolved.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const changedSet = new Set(changed);
  const files = tests.filter((test) => {
    if (changedSet.has(test)) {
      return true;
    }
    if ([...graph.closure(test)].some((file) => changedSet.has(file))) {
      return true;
    }
    return (inputs[test] ?? []).some((pattern) => {
      const glob = new Bun.Glob(pattern);
      return changed.some((file) => glob.match(file));
    });
  });
  return { files, skipped: tests.length - files.length };
};

/** Workflow text minus comment lines: a mention in a comment runs nothing. */
const withoutComments = (workflowText: string): string =>
  workflowText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/** Tests whose repository path appears in no workflow command. */
export const unlistedTests = (
  tests: readonly string[],
  workflowText: string,
): string[] => {
  const commands = withoutComments(workflowText);
  return tests.filter((test) => !commands.includes(test)).toSorted();
};

const scan = (pattern: string): string[] => [
  ...new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT }),
];

const TRACE_STRING_LIMIT = 65_535;

const TRACE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  v: 0x0b,
  f: 0x0c,
  "\\": 0x5c,
  '"': 0x22,
  "'": 0x27,
};

/**
 * A path as strace printed it, back as the bytes it names: strace writes
 * `\t`, `\n`, `\\`, `\"` and similar C escapes, and every other unprintable
 * or non-ASCII byte as a 1–3 digit octal escape.
 */
export const decodeTraceString = (value: string): string => {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = String.fromCodePoint(value.codePointAt(index) ?? 0);
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf-8"));
      index += char.length - 1;
      continue;
    }
    const next = value[index + 1] ?? "";
    const escape = TRACE_ESCAPES[next];
    if (escape !== undefined) {
      bytes.push(escape);
      index += 1;
      continue;
    }
    let digits = "";
    while (
      digits.length < 3 &&
      (value[index + 1 + digits.length] ?? "") >= "0" &&
      (value[index + 1 + digits.length] ?? "") <= "7"
    ) {
      digits += value[index + 1 + digits.length];
    }
    if (digits === "") {
      panic(`Unknown strace escape in trace record: ${value}`);
    }
    bytes.push(Number.parseInt(digits, 8));
    index += digits.length;
  }
  return Buffer.from(bytes).toString("utf-8");
};
// strace marks a string it cut short with "..." after the closing quote.
const TRUNCATED_STRING = /"\.\.\./u;
const assertWholeRecord = (line: string) => {
  if (TRUNCATED_STRING.test(line)) {
    panic(`Truncated trace record; raise the strace string limit: ${line}`);
  }
};

export const undeclaredTracedFiles = ({
  trace,
  closure,
  declared,
  tracked,
}: {
  readonly trace: string;
  readonly closure: ReadonlySet<string>;
  readonly declared: readonly string[];
  readonly tracked: ReadonlySet<string>;
}): string[] => {
  const globs = declared.map((pattern) => new Bun.Glob(pattern));
  const opened = new Set<string>();
  for (const line of joinedTraceRecords(trace)) {
    assertWholeRecord(line);
    const match =
      /(?:open|openat|openat2|execve)\([^"]*"((?:\\.|[^"])*)"/u.exec(line);
    if (match?.[1] === undefined) {
      continue;
    }
    const openedPath = decodeTraceString(match[1]);
    const directory = pathDirectoryAnnotation(line);
    const absolute = path.isAbsolute(openedPath)
      ? path.normalize(openedPath)
      : path.resolve(directory ?? REPO_ROOT, openedPath);
    const relative = repoRelativePath(REPO_ROOT, absolute);
    if (
      relative.startsWith("../") ||
      relative.startsWith("node_modules/") ||
      relative.startsWith(".git/") ||
      closure.has(relative) ||
      !tracked.has(relative) ||
      globs.some((glob) => glob.match(relative))
    ) {
      continue;
    }
    opened.add(relative);
  }
  return [...opened].toSorted();
};

type ScanRecord = {
  readonly directory: string;
  readonly pattern?: string;
  readonly command?: string;
};

const repositoryScan = (
  directory: string,
  root: string,
): { readonly absolute: string; readonly relative: string } | undefined => {
  const absolute = path.resolve(root, directory);
  const relative = repoRelativePath(root, absolute).replace(/\/$/u, "");
  // Outside the checkout (its parent included), installed packages and Git's
  // own store are never repository inputs; Bun's resolver lists some of them.
  const segments = relative.split("/");
  if (
    segments[0] === ".." ||
    segments.includes("node_modules") ||
    segments[0] === ".git"
  ) {
    return undefined;
  }
  return { absolute, relative: relative === "." ? "" : relative };
};

const scanCovered = ({
  record,
  declared,
  root,
}: {
  readonly record: ScanRecord;
  readonly declared: readonly string[];
  readonly root: string;
}): boolean => {
  const repository = repositoryScan(record.directory, root);
  if (repository === undefined) {
    return true;
  }
  const directorySegments = repository.relative.split("/").filter(Boolean);
  return declared.some((pattern) => {
    const segments = pattern.split("/");
    if (
      segments.at(-1) !== "**" ||
      segments.length > directorySegments.length + 1
    ) {
      return false;
    }
    return segments
      .slice(0, -1)
      .every((segment, index) => segment === directorySegments[index]);
  });
};

const tracePid = (line: string): string | undefined =>
  /^\s*(\d+)\s/u.exec(line)?.[1];

const updateWorkingDirectory = (
  line: string,
  pid: string,
  workingDirectories: Map<string, string>,
): boolean => {
  const annotatedDirectory = /\bAT_FDCWD<([^>]+)>/u.exec(line)?.[1];
  if (annotatedDirectory !== undefined) {
    workingDirectories.set(pid, decodeTraceString(annotatedDirectory));
  }
  const changedDirectory = /\bchdir\("((?:\\.|[^"\\])*)"\)\s+=\s+0/u.exec(
    line,
  )?.[1];
  if (changedDirectory !== undefined) {
    const cwd = workingDirectories.get(pid);
    if (cwd !== undefined) {
      workingDirectories.set(
        pid,
        path.resolve(cwd, decodeTraceString(changedDirectory)),
      );
    }
    return true;
  }
  const changedFdDirectory = /\bfchdir\(\d+<([^>]+)>\)\s+=\s+0/u.exec(
    line,
  )?.[1];
  if (changedFdDirectory === undefined) {
    return false;
  }
  workingDirectories.set(pid, decodeTraceString(changedFdDirectory));
  return true;
};

// With -yy, strace annotates the directory descriptor that a relative path
// argument resolves against: `openat(AT_FDCWD</repo>, "file", …)`.
const pathDirectoryAnnotation = (line: string): string | undefined => {
  const beforePath = line.slice(0, line.indexOf('"'));
  const open = beforePath.indexOf("<");
  const close = beforePath.indexOf(">", open);
  if (open === -1 || close === -1) {
    return undefined;
  }
  const descriptor = beforePath.slice(0, open);
  const last = descriptor.at(-1);
  return descriptor.endsWith("AT_FDCWD") ||
    (last !== undefined && last >= "0" && last <= "9")
    ? beforePath.slice(open + 1, close)
    : undefined;
};

const joinedTraceRecords = (trace: string): string[] => {
  const records: string[] = [];
  const unfinished = new Map<string, string>();
  for (const line of trace.split("\n")) {
    const pid = tracePid(line);
    if (pid === undefined) {
      continue;
    }
    if (line.includes("<unfinished ...>")) {
      unfinished.set(
        pid,
        line.slice(0, line.lastIndexOf("<unfinished ...>")).trimEnd(),
      );
      continue;
    }
    const resumed = /^\s*\d+\s+<\.\.\.\s+\S+\s+resumed>(.*)$/u.exec(line);
    if (resumed !== null) {
      const start = unfinished.get(pid);
      if (start !== undefined) {
        records.push(`${start}${resumed[1] ?? ""}`);
        unfinished.delete(pid);
      }
      continue;
    }
    records.push(line);
  }
  return records;
};

// Git options that come before the subcommand and take a separate value.
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--exec-path",
  "--super-prefix",
]);

/**
 * The subcommand of a `git` invocation after its global options, the
 * directory its `-C` options move it to (relative to where it starts), and
 * the subcommand's own arguments.
 */
export const gitInvocation = (args: readonly string[]) => {
  let directory = ".";
  let index = 1;
  while ((args[index] ?? "").startsWith("-")) {
    const option = args[index] ?? "";
    if (option === "-C") {
      directory = path.join(directory, args[index + 1] ?? ".");
    }
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  return {
    subcommand: args[index],
    directory,
    rest: args.slice(index + 1),
  };
};

/**
 * The directory a `getdents` call lists. Every directory listing, whatever
 * API or child process makes it, reads its entries through this call, and
 * -yy names the directory behind the descriptor.
 */
const listedDirectory = (line: string): string | undefined => {
  const call = line.indexOf(" getdents");
  if (call === -1) {
    return undefined;
  }
  const open = line.indexOf("<", call);
  const close = line.indexOf(">,", open);
  return open === -1 || close === -1
    ? undefined
    : decodeTraceString(line.slice(open + 1, close));
};

/** The directories a scanning command lists, or undefined for any other. */
const commandOperands = (
  executable: string,
  args: readonly string[],
  git: ReturnType<typeof gitInvocation> | undefined,
): string[] | undefined => {
  const gitArguments = git?.rest ?? [];
  const separator = gitArguments.indexOf("--");
  if (git?.subcommand === "ls-files") {
    return (
      separator === -1 ? gitArguments : gitArguments.slice(separator + 1)
    ).filter((argument) => !argument.startsWith("-"));
  }
  if (
    git?.subcommand === "grep" ||
    (git?.subcommand === "diff" && gitArguments.includes("--name-only"))
  ) {
    return separator === -1 ? [] : gitArguments.slice(separator + 1);
  }
  if (executable === "find") {
    const findArguments = args.slice(1);
    const expression = findArguments.findIndex(
      (argument) =>
        argument.startsWith("-") || argument === "!" || argument === "(",
    );
    return expression === -1
      ? findArguments
      : findArguments.slice(0, expression);
  }
  if (executable === "ls") {
    return args.slice(1).filter((arg) => !arg.startsWith("-"));
  }
  return undefined;
};

const commandScans = (trace: string): ScanRecord[] => {
  const scans: ScanRecord[] = [];
  const workingDirectories = new Map<string, string>();
  const pending = new Map<string, ScanRecord[]>();
  for (const line of joinedTraceRecords(trace)) {
    const pid = tracePid(line);
    if (pid === undefined) {
      continue;
    }
    const workingDirectoryChanged = updateWorkingDirectory(
      line,
      pid,
      workingDirectories,
    );
    const annotatedCwd = workingDirectories.get(pid);
    if (annotatedCwd !== undefined) {
      for (const record of pending.get(pid) ?? []) {
        scans.push({
          directory: path.resolve(annotatedCwd, record.directory),
        });
      }
      pending.delete(pid);
    }
    if (workingDirectoryChanged) {
      continue;
    }
    assertWholeRecord(line);
    const listed = listedDirectory(line);
    if (listed !== undefined) {
      scans.push({ directory: listed });
      continue;
    }
    const call = /execve\([^,]+, \[((?:.|\n)*?)\],/u.exec(line)?.[1];
    if (call === undefined) {
      continue;
    }
    const args = [...call.matchAll(/"((?:\\.|[^"\\])*)"/gu)].map((match) =>
      decodeTraceString(match[1] ?? ""),
    );
    const executable = path.basename(args[0] ?? "");
    const git = executable === "git" ? gitInvocation(args) : undefined;
    const traced = workingDirectories.get(pid);
    const cwd =
      git === undefined || traced === undefined
        ? traced
        : path.resolve(traced, git.directory);
    const operands = commandOperands(executable, args, git);
    if (operands === undefined) {
      continue;
    }
    for (const operand of operands.length === 0 ? ["."] : operands) {
      // An untraced working directory resolves later; `git -C` still applies.
      const directory =
        git !== undefined && traced === undefined
          ? path.join(git.directory, operand)
          : operand;
      const record = {
        directory: cwd === undefined ? directory : path.resolve(cwd, directory),
        ...(cwd === undefined ? { command: executable } : {}),
      };
      if (cwd === undefined) {
        const records = pending.get(pid) ?? [];
        records.push(record);
        pending.set(pid, records);
      } else {
        scans.push(record);
      }
    }
  }
  return [...scans, ...pending.values()].flat();
};

export const uncoveredScans = ({
  scanLog,
  trace = "",
  declared,
  tracked,
  root = REPO_ROOT,
  testFile,
}: {
  readonly scanLog: string;
  readonly trace?: string;
  readonly declared: readonly string[];
  readonly tracked: ReadonlySet<string>;
  readonly root?: string;
  readonly testFile?: string;
}): ScanRecord[] => {
  // Kept in the public options because callers already own this census; scan
  // coverage itself is deliberately independent of today's tracked files.
  void tracked;
  const parseRecord = (line: string): ScanRecord => {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("directory" in parsed) ||
      typeof parsed.directory !== "string" ||
      ("pattern" in parsed && typeof parsed.pattern !== "string") ||
      ("recursive" in parsed && parsed.recursive !== true)
    ) {
      panic(`Invalid script test scan record: ${line}`);
    }
    if ("pattern" in parsed && typeof parsed.pattern === "string") {
      return {
        directory: parsed.directory,
        pattern: parsed.pattern,
      };
    }
    return {
      directory: parsed.directory,
    };
  };
  const records = scanLog.split("\n").filter(Boolean).map(parseRecord);
  const commandRecords = commandScans(trace);
  const unresolvedCommand = commandRecords.find(
    (record) => record.command !== undefined,
  )?.command;
  if (unresolvedCommand !== undefined) {
    panic(
      `${testFile ?? "script test"}: cannot resolve the working directory of a scan by ${unresolvedCommand}`,
    );
  }
  return [...records, ...commandRecords].filter(
    (record) => !scanCovered({ record, declared, root }),
  );
};

type RunOptions = {
  readonly command: readonly string[];
  readonly testFile: string;
  readonly trace: boolean;
  readonly graph: ReturnType<typeof buildImportGraph>;
  readonly tracked: ReadonlySet<string>;
};

/**
 * Runs `command` with its output in files, then prints it whole, so commands
 * running at once never interleave their reports. Files, not pipes: a piped
 * stdout is truncated for large test reports.
 */
const run = async ({
  command,
  testFile,
  trace,
  graph,
  tracked,
}: RunOptions): Promise<boolean> => {
  const directory = mkdtempSync(path.join(tmpdir(), "unlisted-script-tests-"));
  const stdoutPath = path.join(directory, "stdout.log");
  const stderrPath = path.join(directory, "stderr.log");
  try {
    const tracePath = path.join(directory, "trace.log");
    const scanLogPath = path.join(directory, "scans.log");
    writeFileSync(scanLogPath, "");
    const testCommand =
      command[0] === "bun" && command[1] === "test"
        ? [
            command[0],
            command[1],
            "--preload",
            path.join(REPO_ROOT, SCAN_PRELOAD_PATH),
            ...command.slice(2),
          ]
        : [...command];
    const invoked = trace
      ? [
          "strace",
          "-f",
          // A kernel filter stops the test only at the traced calls; without
          // it every syscall of Bun's threads round-trips through strace.
          "--seccomp-bpf",
          "-yy",
          // strace cuts strings at 32 bytes by default; a cut path would
          // not match a tracked file and escape verification.
          "-s",
          String(TRACE_STRING_LIMIT),
          "-e",
          "trace=open,openat,openat2,execve,clone,clone3,fork,vfork,chdir,fchdir,getdents,getdents64",
          "-o",
          tracePath,
          ...testCommand,
        ]
      : testCommand;
    const started = performance.now();
    const child = Bun.spawn(invoked, {
      cwd: REPO_ROOT,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
      env: { ...process.env, SCRIPT_TEST_SCAN_LOG: scanLogPath },
    });
    const exitCode = await child.exited;
    console.log(`$ ${command.join(" ")}`);
    process.stdout.write(readFileSync(stdoutPath, "utf-8"));
    process.stderr.write(readFileSync(stderrPath, "utf-8"));
    const traceText = trace ? readFileSync(tracePath, "utf-8") : "";
    const undeclared = trace
      ? undeclaredTracedFiles({
          trace: traceText,
          closure: tracedAllowance((file) => graph.closure(file), testFile),
          declared: declaredInputs.get(testFile) ?? [],
          tracked,
        })
      : [];
    if (trace) {
      console.log(
        `Traced ${testFile} in ${Math.round(performance.now() - started)}ms.`,
      );
      for (const file of undeclared) {
        console.error(`${testFile} opened undeclared tracked file ${file}`);
      }
    }
    const scans = uncoveredScans({
      scanLog: readFileSync(scanLogPath, "utf-8"),
      trace: traceText,
      declared: declaredInputs.get(testFile) ?? [],
      tracked,
      testFile,
    });
    for (const uncovered of scans) {
      console.error(
        `${testFile}: scans ${uncovered.directory} (${uncovered.pattern ?? "directory entries"}) without a declared glob covering it`,
      );
    }
    return exitCode === 0 && undeclared.length === 0 && scans.length === 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** Bun test processes at once: two, so this check and the other checks
 *  of the job's pool stay close to the runner's four cores. */
const UNLISTED_TEST_GROUPS = 2;

if (import.meta.main) {
  const options = parseScriptTestArguments(process.argv.slice(2));
  if (options.type === "invalid") {
    console.error(
      `Usage: bun scripts/run-unlisted-script-tests.ts [--timeout <positive integer>]\n${options.message}`,
    );
    process.exitCode = 2;
  } else {
    // Pooled checks run their commands from the check pool registries.
    const workflowText = readCiCheckCommandText(REPO_ROOT);
    const unlisted = unlistedTests(
      scan(TEST_GLOB).filter((file) => !file.includes("/node_modules/")),
      workflowText,
    );
    const base = comparisonBase();
    const selection =
      base === undefined
        ? {
            files: unlisted,
            skipped: 0,
            reason: "no comparison base is available",
          }
        : selectScriptTests({
            tests: unlisted,
            changed: changedFilesSince(base),
          });
    console.log(
      `Selected ${selection.files.length} and skipped ${selection.skipped} unlisted script test file(s).`,
    );
    if (selection.reason !== undefined) {
      console.log(`Full run: ${selection.reason}.`);
    }
    const hasStrace = () =>
      Bun.spawnSync(["sh", "-c", "command -v strace"], { stdout: "ignore" })
        .exitCode === 0;
    // Hosted runner images ship without strace. CI installs it only when a
    // test will run, so a change that selects none pays nothing for it.
    const straceAvailable = prepareStrace({
      ci: process.env["CI"] === "true",
      selectedTests: selection.files.length,
      available: hasStrace,
    });
    if (!straceAvailable) {
      console.log("Tracing skipped: strace is not installed.");
    }
    const graph = buildImportGraph(REPO_ROOT, [
      ...selection.files.filter((file) => file.endsWith(".ts")),
      RUNNER_PATH,
      SCAN_PRELOAD_PATH,
    ]);
    const tracked = trackedFiles();
    const commands = selection.files.map((file) => ({
      file,
      command:
        unlistedTestCommands({
          files: [file],
          timeout: options.timeout,
          groups: UNLISTED_TEST_GROUPS,
          weightOf: (entry) => statSync(path.join(REPO_ROOT, entry)).size,
        })[0] ?? panic(`No command for ${file}`),
    }));
    let nextCommand = 0;
    const results: boolean[] = [];
    await Promise.all(
      Array.from(
        { length: Math.min(UNLISTED_TEST_GROUPS, commands.length) },
        async () => {
          while (nextCommand < commands.length) {
            const entry = commands[nextCommand];
            nextCommand += 1;
            if (entry !== undefined) {
              results.push(
                await run({
                  command: entry.command,
                  testFile: entry.file,
                  trace: straceAvailable,
                  graph,
                  tracked,
                }),
              );
            }
          }
        },
      ),
    );
    if (results.includes(false)) {
      panic("Unlisted script tests failed");
    }
    console.log(`Ran ${selection.files.length} unlisted script test file(s).`);
  }
}
