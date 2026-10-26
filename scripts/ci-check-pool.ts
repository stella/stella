// Runs the checks of one CI job in a bounded process pool.
//
// Each check in .github/ci-checks/<job>.yml keeps the fields of the workflow
// step it replaced. The pool evaluates every condition against the job's own
// context (event, `needs`, earlier step outcomes and outputs), so selection by
// changed inputs and static-receipt reuse behave exactly as they did per step.
// Selected checks run concurrently, one fewer than the runner CPUs; each log is
// printed whole, in registry order, and every failure is annotated. Any failed
// check fails the step after all selected checks have finished, unless its
// `continue-on-error` holds: then its conclusion is success. Every failed check
// still emits an error annotation so the failure digest can report its cause.
//
// The pool runs even when dependency installation failed (install-free checks
// still run), so it imports no packages.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import {
  CHECK_POOL_JOBS,
  checkBudgetMinutes,
  type CheckPoolJob,
  checkPoolResultsPath,
  type PoolCheck,
  readCheckBudgets,
  readCheckPool,
} from "./ci-check-pool-registry";
import {
  type Context,
  evaluate,
  toValue,
  UNKNOWN,
  type Value,
} from "./github-expression";

class CheckPoolError extends Error {
  override name = "CheckPoolError";
  readonly _tag = "CheckPoolError";
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (source: string | undefined, label: string): Value => {
  if (source === undefined || source === "") {
    throw new CheckPoolError(`Missing ${label}`);
  }
  const parsed: unknown = JSON.parse(source);
  return toValue(parsed);
};

/**
 * The workflow contexts a pooled expression may read. The pool step hands
 * each one over (CI_CHECK_POOL_<ROOT>); any other root is unknown, and a
 * census test keeps every pooled expression within these.
 */
export const POOL_CONTEXT_ROOTS = [
  "github",
  "needs",
  "steps",
  "inputs",
] as const;
type PoolContextOptions = {
  github: Record<string, Value>;
  needs: Value;
  steps: Value;
  /** `null` outside workflow_dispatch and workflow_call, as GitHub renders it. */
  inputs: Value;
};
/**
 * GitHub's context for a step in this job. A missing property reads as null,
 * as it does in a workflow expression; status functions other than
 * `cancelled()` are unknown, so a condition that needs them fails loudly.
 */
export const poolContext = ({
  github,
  needs,
  steps,
  inputs,
}: PoolContextOptions): Context => {
  const roots = new Map<string, Value>([
    ["github", github],
    ["needs", needs],
    ["steps", steps],
    ["inputs", inputs],
  ]);
  return {
    values: {},
    status: { cancelled: false },
    fallback: (reference) => {
      const [root, ...parts] = reference.split(".");
      if (root === undefined || !roots.has(root)) {
        return undefined;
      }
      let value: unknown = roots.get(root);
      for (const part of parts) {
        value =
          record(value) && Object.hasOwn(value, part) ? value[part] : null;
      }
      return toValue(value ?? null);
    },
  };
};

const truthy = (value: Value) =>
  !(
    value === false ||
    value === null ||
    value === 0 ||
    value === "" ||
    Number.isNaN(value)
  );

export const conditionHolds = (condition: string, context: Context) => {
  const value = evaluate(condition, context);
  if (value === UNKNOWN) {
    throw new CheckPoolError(`Condition is not decidable: ${condition}`);
  }
  return truthy(value);
};

/**
 * Whether a failure of this check may let the pool pass, as `continue-on-error`
 * does for a step. An expression the pool cannot decide fails closed: the
 * check stays blocking.
 */
export const continueOnErrorHolds = (
  declared: PoolCheck["continueOnError"],
  context: Context,
) => {
  if (declared === undefined || typeof declared === "boolean") {
    return declared === true;
  }
  try {
    const value = evaluate(declared, context);
    return value !== UNKNOWN && truthy(value);
  } catch {
    return false;
  }
};

const EXPRESSION = /^\$\{\{([\s\S]*)\}\}$/u;
/** Resolve `${{ }}` env values the way the runner renders them into a step. */
export const resolveEnv = (
  env: Readonly<Record<string, string>>,
  context: Context,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([key, source]) => {
      const expression = EXPRESSION.exec(source.trim())?.[1];
      if (expression === undefined) {
        if (source.includes("${{")) {
          throw new CheckPoolError(`${key}: embedded expressions unsupported`);
        }
        return [key, source];
      }
      const value = evaluate(expression, context);
      if (value === UNKNOWN) {
        throw new CheckPoolError(`${key}: value is not decidable`);
      }
      if (value === null) {
        return [key, ""];
      }
      return [
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      ];
    }),
  );

export type PlannedCheck =
  | {
      check: PoolCheck;
      status: "selected";
      env: Record<string, string>;
      continueOnError: boolean;
    }
  | { check: PoolCheck; status: "skipped" }
  | { check: PoolCheck; status: "invalid"; message: string };

export const planChecks = (
  checks: readonly PoolCheck[],
  context: Context,
): PlannedCheck[] =>
  checks.map((check) => {
    try {
      return conditionHolds(check.condition, context)
        ? {
            check,
            status: "selected",
            env: resolveEnv(check.env, context),
            continueOnError: continueOnErrorHolds(
              check.continueOnError,
              context,
            ),
          }
        : { check, status: "skipped" };
    } catch (error) {
      return {
        check,
        status: "invalid",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

/** Why the pool stopped a check before it exited by itself. */
export type StopVerdict =
  | { reason: "stuck"; idleMinutes: number }
  | { reason: "over-budget"; budgetMinutes: number };
export type Launched = {
  exitCode: number;
  stopped: StopVerdict | undefined;
  maxRssBytes: number | undefined;
};
export type CheckResult = {
  name: string;
  id: string | undefined;
  outcome: "success" | "failure" | "skipped";
  /** A failure that `continue-on-error` lets pass: conclusion success. */
  continuedOnError: boolean;
  detail: string;
  seconds: number;
  maxRssBytes: number | undefined;
};

/** A failed check's detail when it printed no failed test or error line. */
export const exitCodeDetail = (exitCode: number) => `exit code ${exitCode}`;

// A stopped check's detail is its cause: its log ends in the process dump.
const STOPPED_DETAIL = /^(?:stuck|over budget): /u;
export const stopDetail = (verdict: StopVerdict) =>
  verdict.reason === "stuck"
    ? `stuck: no output and no CPU progress for ${verdict.idleMinutes} min`
    : `over budget: still running after ${verdict.budgetMinutes} min`;

const launchedOutcome = (
  launched: Launched,
): Pick<CheckResult, "outcome" | "detail"> => {
  if (launched.stopped !== undefined) {
    return { outcome: "failure", detail: stopDetail(launched.stopped) };
  }
  return launched.exitCode === 0
    ? { outcome: "success", detail: "passed" }
    : { outcome: "failure", detail: exitCodeDetail(launched.exitCode) };
};

type RunChecksOptions = {
  planned: readonly PlannedCheck[];
  concurrency: number;
  launch: (
    index: number,
    check: PoolCheck,
    env: Record<string, string>,
  ) => Promise<Launched>;
  /** Called once per check, in registry order, as soon as it can be. */
  report: (index: number, result: CheckResult) => void;
  now?: () => number;
};

/**
 * Run selected checks with at most `concurrency` in flight, in registry
 * order. A failure never stops other checks; results come back in order.
 */
export const runChecks = async ({
  planned,
  concurrency,
  launch,
  report,
  now = () => performance.now(),
}: RunChecksOptions): Promise<CheckResult[]> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new CheckPoolError(`Invalid concurrency: ${concurrency}`);
  }
  const results: (CheckResult | undefined)[] = planned.map(() => undefined);
  let reported = 0;
  const settle = (index: number, result: CheckResult) => {
    results[index] = result;
    for (
      let next = results[reported];
      next !== undefined;
      next = results[reported]
    ) {
      report(reported, next);
      reported += 1;
    }
  };
  const queue = planned.flatMap((entry, index) => {
    const base = {
      name: entry.check.name,
      id: entry.check.id,
      continuedOnError: false,
      seconds: 0,
      maxRssBytes: undefined,
    };
    if (entry.status === "skipped") {
      settle(index, { ...base, outcome: "skipped", detail: "condition false" });
      return [];
    }
    if (entry.status === "invalid") {
      settle(index, { ...base, outcome: "failure", detail: entry.message });
      return [];
    }
    return [
      {
        index,
        check: entry.check,
        env: entry.env,
        continueOnError: entry.continueOnError,
      },
    ];
  });
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const started = now();
      const base = { name: item.check.name, id: item.check.id };
      try {
        const launched = await launch(item.index, item.check, item.env);
        const seconds = (now() - started) / 1000;
        const outcome = launchedOutcome(launched);
        settle(item.index, {
          ...base,
          seconds,
          maxRssBytes: launched.maxRssBytes,
          ...outcome,
          continuedOnError:
            item.continueOnError && outcome.outcome === "failure",
        });
      } catch (error) {
        settle(item.index, {
          ...base,
          seconds: (now() - started) / 1000,
          maxRssBytes: undefined,
          outcome: "failure",
          continuedOnError: item.continueOnError,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return results.map((result, index) => {
    if (result === undefined) {
      throw new CheckPoolError(
        `Check did not settle: ${planned[index]?.check.name ?? String(index)}`,
      );
    }
    return result;
  });
};

const POOL_ENV = [
  "CI_CHECK_POOL_NEEDS_FILE",
  "CI_CHECK_POOL_STEPS",
  "CI_CHECK_POOL_INPUTS",
  "CI_CHECK_POOL_TOKEN",
];
const active = new Set<number>();
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
};
const killPid = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
};

type ProcessRow = { pid: number; ppid: number; pgid: number; cpu: number };

/** `ps` CPU time, `[[dd-]hh:]mm:ss[.ff]`, in seconds. */
export const cpuSeconds = (value: string) => {
  const [days, clock] = value.includes("-")
    ? [Number(value.split("-")[0]), value.split("-")[1] ?? ""]
    : [0, value];
  return clock
    .split(":")
    .toReversed()
    .reduce(
      (total, part, position) => total + Number(part) * 60 ** position,
      days * 86_400,
    );
};

const processTable = (): ProcessRow[] => {
  const listed = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,time="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return listed.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const [pid, ppid, pgid, time] = line.trim().split(/\s+/u);
      return pid === undefined || time === undefined
        ? []
        : [
            {
              pid: Number(pid),
              ppid: Number(ppid),
              pgid: Number(pgid),
              cpu: cpuSeconds(time),
            },
          ];
    });
};

/**
 * A check's processes: its group, plus every descendant, since a child can
 * leave the group (setsid, detached spawns) and still hold the check open.
 */
export const processTree = (rows: readonly ProcessRow[], root: number) => {
  const tree = new Set(
    rows.filter(({ pgid }) => pgid === root).map(({ pid }) => pid),
  );
  tree.add(root);
  for (let grown = true; grown;) {
    grown = false;
    for (const { pid, ppid } of rows) {
      if (!tree.has(pid) && tree.has(ppid)) {
        tree.add(pid);
        grown = true;
      }
    }
  }
  return rows.filter(({ pid }) => tree.has(pid));
};

const processDump = (pids: readonly number[]) => {
  const listed = Bun.spawnSync(
    [
      "ps",
      "-ww",
      "-o",
      "pid,ppid,pgid,stat,etime,time,rss,args",
      "-p",
      pids.join(","),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return `${listed.stdout.toString()}${listed.stderr.toString()}`;
};

/** A sample of what a running check has done so far. */
export type Progress = { outputBytes: number; cpuSeconds: number };

type ProcessLauncherOptions = {
  root: string;
  directory: string;
  /** The check's wall-time cap; it applies only while the check progresses. */
  budgetMinutes: (check: PoolCheck) => number;
  /** No output and no CPU time for this long is a stuck check. */
  stuckAfterMs?: number;
  sampleMs?: number;
};
/**
 * Run a check's script the way a `shell: bash` step does, in its own group.
 * A check that neither writes output nor uses CPU for `stuckAfterMs` is stuck;
 * one that keeps progressing runs until its budget. Either stop dumps the
 * check's process tree into its log, then kills the tree.
 */
export const processLauncher =
  ({
    root,
    directory,
    budgetMinutes,
    stuckAfterMs = 10 * 60_000,
    sampleMs = 30_000,
  }: ProcessLauncherOptions) =>
  async (
    index: number,
    check: PoolCheck,
    env: Record<string, string>,
  ): Promise<Launched> => {
    const budget = budgetMinutes(check);
    const script = path.join(directory, `${String(index).padStart(3, "0")}.sh`);
    writeFileSync(script, check.run);
    const log = openSync(logPath(directory, index), "w");
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !POOL_ENV.includes(key)),
    );
    const child = Bun.spawn(
      ["bash", "--noprofile", "--norc", "-eo", "pipefail", script],
      {
        cwd: root,
        env: { ...inherited, ...env },
        stdin: "ignore",
        stdout: log,
        stderr: log,
        detached: true,
      },
    );
    active.add(child.pid);
    let stopped: StopVerdict | undefined;
    let dump = "";
    const stop = (verdict: StopVerdict) => {
      if (stopped !== undefined) {
        return;
      }
      stopped = verdict;
      const tree = processTree(processTable(), child.pid).map(({ pid }) => pid);
      dump = processDump(tree);
      for (const pid of tree) {
        killPid(pid);
      }
      killGroup(child.pid);
    };
    const sample = (): Progress => ({
      outputBytes: fstatSync(log).size,
      cpuSeconds: processTree(processTable(), child.pid).reduce(
        (total, { cpu }) => total + cpu,
        0,
      ),
    });
    let last = sample();
    let progressedAt = performance.now();
    const watch = setInterval(() => {
      const now = sample();
      if (
        now.outputBytes > last.outputBytes ||
        now.cpuSeconds > last.cpuSeconds
      ) {
        progressedAt = performance.now();
      }
      last = {
        outputBytes: Math.max(now.outputBytes, last.outputBytes),
        cpuSeconds: Math.max(now.cpuSeconds, last.cpuSeconds),
      };
      if (performance.now() - progressedAt >= stuckAfterMs) {
        stop({
          reason: "stuck",
          idleMinutes: Math.round((stuckAfterMs / 60_000) * 10) / 10,
        });
      }
    }, sampleMs);
    const cap = setTimeout(
      () => stop({ reason: "over-budget", budgetMinutes: budget }),
      budget * 60_000,
    );
    const exitCode = await child.exited;
    clearInterval(watch);
    clearTimeout(cap);
    // Nothing a check starts may outlive it and contend with the next one.
    killGroup(child.pid);
    active.delete(child.pid);
    if (stopped !== undefined) {
      writeSync(
        log,
        `\nerror: ${stopDetail(stopped)}; its processes when stopped:\n${dump}`,
      );
    }
    closeSync(log);
    const usage = child.resourceUsage();
    return {
      exitCode,
      stopped,
      maxRssBytes: usage?.maxRSS,
    };
  };

const logPath = (directory: string, index: number) =>
  path.join(directory, `${String(index).padStart(3, "0")}.log`);

const CANCELLATION_LOG_TAIL_BYTES = 8 * 1024;
const CANCELLATION_LOG_TOTAL_BYTES = 64 * 1024;
type UnreportedCheck = { name: string; status: "running" | "completed" };

const readLogTail = (file: string, limit: number) => {
  const fd = openSync(file, "r");
  try {
    const { size } = fstatSync(fd);
    const buffer = Buffer.alloc(Math.min(size, limit));
    const bytes = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, bytes).toString("utf-8");
  } finally {
    closeSync(fd);
  }
};

const printUnreportedLogs = (
  directory: string,
  unreported: ReadonlyMap<number, UnreportedCheck>,
) => {
  const omitted = "Log tail omitted: cancellation output limit reached.\n";
  let remaining = CANCELLATION_LOG_TOTAL_BYTES - Buffer.byteLength(omitted);
  let flushStatus: "complete" | "truncated" = "complete";
  for (const [index, { name, status }] of unreported) {
    const heading = `::group::Interrupted check: ${name} (${status})\n`;
    const closing = "\n::endgroup::\n";
    const framingBytes = Buffer.byteLength(heading + closing);
    if (remaining < framingBytes) {
      flushStatus = "truncated";
      break;
    }
    let tail: string;
    try {
      tail = readLogTail(
        logPath(directory, index),
        CANCELLATION_LOG_TAIL_BYTES,
      );
    } catch {
      tail = "Log tail unavailable.";
    }
    // Partial logs are evidence, not check outcomes or workflow commands.
    const bytes = Buffer.from(
      tail
        .replaceAll("\r", "\n")
        .split("\n")
        .map((line) => `| ${line}`)
        .join("\n"),
    );
    const limit = remaining - framingBytes;
    // Streaming decode drops an incomplete final code point instead of adding
    // replacement bytes beyond the remaining output budget.
    const text = new TextDecoder().decode(bytes.subarray(0, limit), {
      stream: true,
    });
    const frame = heading + text + closing;
    writeOut(frame);
    remaining -= Buffer.byteLength(frame);
    if (bytes.length > limit) {
      flushStatus = "truncated";
      break;
    }
  }
  if (flushStatus === "truncated") {
    writeOut(omitted);
  }
};

// The runner reads a workflow command after leading whitespace, so a command
// is neutralized by removing it or by a non-blank prefix, never by indenting.
// A nested group would end the check's own group in the job log: its title
// stays as a plain line (Bun's per-file header) and its end is dropped.
const NESTED_GROUP_START = /^[ \t]*(?:::group::|##\[group\])/gmu;
const NESTED_GROUP_END =
  /^[ \t]*(?:::endgroup::|##\[endgroup\]).*(?:\r?\n|$)/gmu;
// An error command printed by a check that passed comes from a fixture or a
// refusal the check exercises, never from this run's failure; left active it
// becomes a job annotation that failure digests then report as the cause.
const ERROR_COMMAND = /^([ \t]*(?:::error\b|##\[error\]))/gmu;

/** A check's log as the job log shows it, so the check cannot drive the job's commands. */
export const checkLogText = (
  output: string,
  outcome: CheckResult["outcome"],
): string => {
  const flat = output
    .replace(NESTED_GROUP_END, "")
    .replace(NESTED_GROUP_START, "");
  return outcome === "failure" ? flat : flat.replace(ERROR_COMMAND, "| $1");
};
const escapeProperty = (value: string) =>
  value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
const escapeData = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const FAILURE_CAUSE_LIMIT = 500;

const isResultMarker = (line: string) =>
  /^\((?:pass|fail|skip|todo)\) /u.test(line.trimStart());

// Bun's own banner, per-file headers, totals and group commands.
const TEST_RUNNER_LINE =
  /^(?:bun test v|\d+ (?:pass|fail|skip|todo|snapshots?|expect\(\) calls)\b|Ran \d+ tests? |(?:::|##\[)(?:end)?group\b|\S+\.test\.[cm]?[jt]sx?:$)/u;
const isTestRunnerLine = (line: string) =>
  isResultMarker(line) || TEST_RUNNER_LINE.test(line.trim());
// A line that starts with an error, possibly behind a workflow error command.
const ERROR_LINE = /^(?:##\[error\]|::error[^:]*::)?\s*error\b/iu;
// `path[:line[:column]]: finding`, the shape repository checks report in.
const FINDING_LINE =
  /^(?:[\w.@-]+\/)+[\w.@$()[\]-]+(?::\d+){0,2}: \S|^[\w.@-]+\.[a-z\d]+(?::\d+){0,2}: \S/iu;

// Bun prints a test's diagnostics before its `(fail)` line, so the test's own
// error lies between the previous result marker and its marker; output after
// the marker belongs to the next test, even a passing one that logs errors.
const errorOfTest = (lines: readonly string[], failureIndex: number) => {
  let start = failureIndex;
  while (start > 0 && !isResultMarker(lines.at(start - 1) ?? "")) {
    start -= 1;
  }
  return lines
    .slice(start, failureIndex)
    .find((line) => /^error/iu.test(line.trimStart()))
    ?.trim();
};

// The runner renders `::error` commands as `##[error]<message>` in downloaded
// logs and drops the title, so the digest reads this plain record instead.
export const FAILED_CHECK_RECORD = "FAILED check: ";

export const FAILED_CHECK_SEPARATOR = " -- ";

/**
 * The plain log record of one failed pooled check: name and first cause, one
 * line. The name is escaped so it can hold neither the separator nor a line
 * break; ci-failure-digest.ts decodes it.
 */
export const failedCheckRecord = (name: string, cause: string) =>
  `${FAILED_CHECK_RECORD}${escapeData(name).replaceAll("--", "%2D%2D")}${FAILED_CHECK_SEPARATOR}${cause.replaceAll(/\r?\n/gu, " ")}`;

/** The first actionable cause of one failed pooled check. */
export const failedCheckCause = (
  result: Pick<CheckResult, "detail">,
  output: string,
) => {
  if (STOPPED_DETAIL.test(result.detail)) {
    return result.detail;
  }
  const lines = output.split(/\r?\n/u);
  const failureIndex = lines.findIndex((line) =>
    line.trimStart().startsWith("(fail) "),
  );
  const failure =
    failureIndex === -1 ? undefined : lines.at(failureIndex)?.trim();
  const testError =
    failureIndex === -1 ? undefined : errorOfTest(lines, failureIndex);
  // A later line's error may belong to another test, so a failed test without
  // its own diagnostic is named alone.
  if (failure !== undefined) {
    return (
      testError === undefined
        ? failure
        : `${failure}${FAILED_CHECK_SEPARATOR}${testError}`
    ).slice(0, FAILURE_CAUSE_LIMIT);
  }
  // A check that runs its own tests and then reports findings prints the
  // passing tests first; their names are never the finding.
  const findings = lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !isTestRunnerLine(line));
  return (
    findings.find((line) => ERROR_LINE.test(line) || FINDING_LINE.test(line)) ??
    findings.find((line) => /\berror\b/iu.test(line)) ??
    result.detail
  ).slice(0, FAILURE_CAUSE_LIMIT);
};

/** The single workflow annotation emitted for one failed pooled check. */
export const failedCheckAnnotation = (
  result: Pick<CheckResult, "name" | "detail">,
  output: string,
) =>
  `::error title=${escapeProperty(`${FAILED_CHECK_RECORD}${result.name}`)}::${escapeData(failedCheckCause(result, output))}`;

const seconds = (value: number) => `${value.toFixed(1)} s`;
const mebibytes = (bytes: number | undefined) =>
  bytes === undefined ? "" : String(Math.round(bytes / 1_048_576));

// Markdown table cell: a pipe would end the cell and a line break the row.
const cell = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/gu, " ");

export const summaryTable = (results: readonly CheckResult[]) =>
  [
    "| Check | Result | Seconds | Peak RSS (MiB) |",
    "| --- | --- | ---: | ---: |",
    ...results.map((result) => {
      const failure = result.continuedOnError
        ? "failure (continue-on-error)"
        : "failure";
      const outcome =
        result.outcome === "failure"
          ? `${failure}: ${result.detail}`
          : result.outcome;
      const elapsed =
        result.outcome === "skipped" ? "" : result.seconds.toFixed(1);
      return `| ${cell(result.name)} | ${cell(outcome)} | ${elapsed} | ${mebibytes(result.maxRssBytes)} |`;
    }),
  ].join("\n");

// One synchronous writer: a large asynchronous stdout write could otherwise
// interleave with the next check's lines.
const pause = new Int32Array(new SharedArrayBuffer(4));
const writeOut = (text: string) => {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    try {
      offset += writeSync(1, bytes, offset);
    } catch (error) {
      // A non-blocking pipe that is full: wait briefly and retry.
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EAGAIN"
      )) {
        throw error;
      }
      Atomics.wait(pause, 0, 0, 5);
    }
  }
};
const print = (...parts: string[]) => {
  writeOut(`${parts.join(" ")}\n`);
};

/** Failures that fail the pool step: those `continue-on-error` does not cover. */
export const blockingFailures = (results: readonly CheckResult[]) =>
  results.filter(
    ({ outcome, continuedOnError }) =>
      outcome === "failure" && !continuedOnError,
  );

const isPoolJob = (job: string): job is CheckPoolJob =>
  CHECK_POOL_JOBS.some((known) => known === job);

/** Select an exact, comma-separated subset while retaining manifest order. */
export const selectChecks = (
  checks: readonly PoolCheck[],
  only: string | undefined,
): PoolCheck[] => {
  if (only === undefined) {
    return [...checks];
  }
  const requested = only.split(",").map((name) => name.trim());
  if (requested.some((name) => name === "")) {
    throw new CheckPoolError("--only requires one or more check names");
  }
  const names = new Set(checks.map(({ name }) => name));
  const unknown = requested.filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new CheckPoolError(`Unknown check name(s): ${unknown.join(", ")}`);
  }
  const selected = new Set(requested);
  return checks.filter(({ name }) => selected.has(name));
};

/** Split a manifest into stable, disjoint CI matrix partitions. */
export const partitionChecks = (
  checks: readonly PoolCheck[],
  partition: string | undefined,
): PoolCheck[] => {
  if (partition === undefined) {
    return [...checks];
  }
  const match = /^(?<index>\d+)\/(?<count>\d+)$/u.exec(partition);
  const index = Number(match?.groups?.["index"]);
  const count = Number(match?.groups?.["count"]);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    count < 1 ||
    index > count
  ) {
    throw new CheckPoolError(
      "CI_CHECK_POOL_PARTITION must have the form <index>/<count>",
    );
  }
  return checks.filter((_, checkIndex) => checkIndex % count === index - 1);
};

const main = async () => {
  const [mode, job = "", option, value, ...extra] = process.argv.slice(2);
  if (
    mode !== "run" ||
    !isPoolJob(job) ||
    extra.length > 0 ||
    (option !== undefined && option !== "--only") ||
    (option === "--only" && value === undefined) ||
    (option === undefined && value !== undefined)
  ) {
    throw new CheckPoolError(
      `Usage: bun scripts/ci-check-pool.ts run ${CHECK_POOL_JOBS.join("|")} [--only <name>[,<name>]]`,
    );
  }
  const root = path.resolve(import.meta.dir, "..");
  const runnerTemp = process.env["RUNNER_TEMP"] ?? path.join(root, ".cache");
  const resultsPath = checkPoolResultsPath(job, runnerTemp);
  const directory = path.dirname(resultsPath);
  mkdirSync(directory, { recursive: true });
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  const github: Record<string, Value> = {
    event_name: process.env["GITHUB_EVENT_NAME"] ?? "",
    base_ref: process.env["GITHUB_BASE_REF"] ?? "",
    head_ref: process.env["GITHUB_HEAD_REF"] ?? "",
    ref: process.env["GITHUB_REF"] ?? "",
    repository: process.env["GITHUB_REPOSITORY"] ?? "",
    workspace: process.env["GITHUB_WORKSPACE"] ?? root,
    token: process.env["CI_CHECK_POOL_TOKEN"] ?? "",
    event: eventPath ? json(readFileSync(eventPath, "utf-8"), "event") : {},
  };
  const needsFile = process.env["CI_CHECK_POOL_NEEDS_FILE"];
  const context = poolContext({
    github,
    // A file, never the environment: ci-plan's outputs can exceed the
    // 128 KiB limit of one environment value.
    needs: json(
      needsFile ? readFileSync(needsFile, "utf-8") : undefined,
      "needs context",
    ),
    steps: json(process.env["CI_CHECK_POOL_STEPS"], "steps context"),
    inputs: json(process.env["CI_CHECK_POOL_INPUTS"], "inputs context"),
  });
  const planned = planChecks(
    partitionChecks(
      selectChecks(readCheckPool(job), value),
      process.env["CI_CHECK_POOL_PARTITION"],
    ),
    context,
  );
  const override = process.env["CI_CHECK_POOL_CONCURRENCY"];
  // One check per CPU but one: four concurrent checks on a four-CPU runner
  // pushed default 5 s Bun test budgets past their limit; three did not.
  const concurrency = override
    ? Number(override)
    : Math.max(1, availableParallelism() - 1);
  const selected = planned.filter(({ status }) => status === "selected").length;
  print(
    `${job}: ${selected} of ${planned.length} checks selected; running ${Math.min(concurrency, selected)} at a time`,
  );
  const unreported = new Map<number, UnreportedCheck>();
  const stop = () => {
    const running = [...active].flatMap((pid) =>
      processTree(processTable(), pid).map((row) => row.pid),
    );
    if (running.length > 0) {
      writeOut(
        `::group::Processes of running checks\n${processDump(running)}::endgroup::\n`,
      );
    }
    for (const pid of active) {
      killGroup(pid);
    }
    try {
      printUnreportedLogs(directory, unreported);
    } finally {
      process.exit(130);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const started = performance.now();
  const budgets = readCheckBudgets(root);
  const launch = processLauncher({
    root,
    directory,
    budgetMinutes: ({ name }) => checkBudgetMinutes(budgets, job, name),
  });
  const results = await runChecks({
    planned,
    concurrency,
    launch: async (index, check, env) => {
      unreported.set(index, { name: check.name, status: "running" });
      print(`Starting check: ${check.name}`);
      try {
        return await launch(index, check, env);
      } finally {
        unreported.set(index, { name: check.name, status: "completed" });
      }
    },
    report: (index, result) => {
      unreported.delete(index);
      if (result.outcome === "skipped") {
        print(`Skipped: ${result.name} (${result.detail})`);
        return;
      }
      let label = "passed";
      if (result.outcome === "failure") {
        label = result.continuedOnError
          ? "FAILED (continue-on-error)"
          : "FAILED";
      }
      print(`::group::${result.name}: ${label} in ${seconds(result.seconds)}`);
      const output =
        planned[index]?.status === "selected"
          ? readFileSync(logPath(directory, index), "utf-8")
          : "";
      if (planned[index]?.status === "selected") {
        const text = checkLogText(output, result.outcome);
        writeOut(text === "" || text.endsWith("\n") ? text : `${text}\n`);
      }
      print("::endgroup::");
      if (result.outcome === "failure") {
        print(failedCheckAnnotation(result, output));
        print(failedCheckRecord(result.name, failedCheckCause(result, output)));
      }
    },
  });
  const table = summaryTable(results);
  print(
    `\n${table}\n\nWall time: ${seconds((performance.now() - started) / 1000)}`,
  );
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    appendFileSync(summary, `### ${job} checks\n\n${table}\n\n`);
  }
  writeFileSync(
    resultsPath,
    JSON.stringify(
      Object.fromEntries(
        results.flatMap(({ id, outcome, continuedOnError }) =>
          id === undefined
            ? []
            : [
                [
                  id,
                  {
                    outcome,
                    conclusion: continuedOnError ? "success" : outcome,
                  },
                ],
              ],
        ),
      ),
    ),
  );
  const failed = blockingFailures(results);
  if (failed.length > 0) {
    print(
      `${failed.length} check(s) failed: ${failed.map(({ name }) => name).join("; ")}`,
    );
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
