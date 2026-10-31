import { Result, TaggedError } from "better-result";
import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };

export class TaskBudgetInputError extends TaggedError("TaskBudgetInputError")<{
  message: string;
}> {}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const milliseconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const taskIdValid = (value: unknown): value is string =>
  typeof value === "string" && /^[^\s#|]+#[^\s#|]+$/u.test(value);
const invalid = (message: string): never => {
  throw new TaskBudgetInputError({ message });
};

export type TaskBudgets = {
  defaultSeconds: number;
  overrides: Readonly<Record<string, number>>;
};
export const parseTaskBudgets = (value: unknown): TaskBudgets => {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !["defaultSeconds", "overrides"].includes(key),
    ) ||
    !milliseconds(value["defaultSeconds"]) ||
    value["defaultSeconds"] === 0 ||
    !record(value["overrides"])
  ) {
    return invalid("Invalid code-quality task budgets");
  }
  const overrides = Object.fromEntries(
    Object.entries(value["overrides"]).map(([task, seconds]) => {
      if (!taskIdValid(task) || !milliseconds(seconds) || seconds === 0) {
        return invalid(`Invalid task budget for ${task}`);
      }
      return [task, seconds] satisfies [string, number];
    }),
  );
  return { defaultSeconds: value["defaultSeconds"], overrides };
};
export const DEFAULT_TASK_BUDGETS = parseTaskBudgets({
  defaultSeconds: configuredBudgets.defaultSeconds,
  overrides: configuredBudgets.overrides,
});

type TaskExecution = {
  startTime: number;
  endTime: number;
  exitCode: number | null;
};
export type TurboBudgetTask = {
  taskId: string;
  cache: "HIT" | "MISS";
  execution?: TaskExecution;
};
export type TurboRunSummary = {
  tasks: TurboBudgetTask[];
  execution: { startTime: number; endTime: number };
};

// Turbo 2.11.6: crates/turborepo-run-summary/src/{task,tracker,execution}.rs.
// Execution times are timestamp_millis(), not seconds or cache.timeSaved.
export const parseTurboRunSummary = (value: unknown): TurboRunSummary => {
  if (
    !record(value) ||
    value["version"] !== "1" ||
    !Array.isArray(value["tasks"])
  ) {
    return invalid("Invalid Turbo run summary schema");
  }
  const run = value["execution"];
  if (
    !record(run) ||
    !milliseconds(run["startTime"]) ||
    !milliseconds(run["endTime"]) ||
    run["endTime"] < run["startTime"] ||
    typeof run["exitCode"] !== "number" ||
    !Number.isSafeInteger(run["exitCode"])
  ) {
    return invalid("Turbo summary must contain a real run execution");
  }
  const tasks: TurboBudgetTask[] = [];
  const seen = new Set<string>();
  for (const task of value["tasks"]) {
    if (
      !record(task) ||
      !taskIdValid(task["taskId"]) ||
      !record(task["cache"])
    ) {
      return invalid("Invalid Turbo task identity or cache");
    }
    const taskId = task["taskId"];
    const status = task["cache"]["status"];
    if ((status !== "HIT" && status !== "MISS") || seen.has(taskId)) {
      return invalid(`Invalid or duplicate Turbo task ${taskId}`);
    }
    seen.add(taskId);
    const execution = task["execution"];
    if (execution === undefined) {
      tasks.push({ taskId, cache: status });
      continue;
    }
    if (
      !record(execution) ||
      !milliseconds(execution["startTime"]) ||
      !milliseconds(execution["endTime"]) ||
      execution["endTime"] < execution["startTime"] ||
      !(
        execution["exitCode"] === null ||
        (typeof execution["exitCode"] === "number" &&
          Number.isSafeInteger(execution["exitCode"]))
      )
    ) {
      return invalid(`Invalid execution timestamps or exit code for ${taskId}`);
    }
    tasks.push({
      taskId,
      cache: status,
      execution: {
        startTime: execution["startTime"],
        endTime: execution["endTime"],
        exitCode: execution["exitCode"],
      },
    });
  }
  return {
    tasks,
    execution: { startTime: run["startTime"], endTime: run["endTime"] },
  };
};

const taskCompletionStatus = (task: TurboBudgetTask) => {
  if (task.cache === "HIT") {
    return "cache hit";
  }
  if (task.execution === undefined) {
    return "not executed";
  }
  if (task.execution.exitCode === null) {
    return "completion unconfirmed";
  }
  return "completed";
};

type EvaluateTaskBudgetsOptions = {
  summary: TurboRunSummary;
  budgets?: TaskBudgets;
};
export const evaluateTaskBudgets = ({
  summary,
  budgets = DEFAULT_TASK_BUDGETS,
}: EvaluateTaskBudgetsOptions) => {
  const rows = summary.tasks
    .map((task) => {
      const seconds =
        task.execution === undefined
          ? undefined
          : (task.execution.endTime - task.execution.startTime) / 1000;
      const budgetSeconds =
        budgets.overrides[task.taskId] ?? budgets.defaultSeconds;
      const status = taskCompletionStatus(task);
      return {
        taskId: task.taskId,
        cache: task.cache,
        seconds,
        budgetSeconds,
        status,
        overBudget:
          task.cache === "MISS" &&
          seconds !== undefined &&
          seconds > budgetSeconds,
      };
    })
    .toSorted((left, right) => {
      if (left.taskId < right.taskId) {
        return -1;
      }
      return Number(left.taskId > right.taskId);
    });
  const violations = rows.filter((row) => row.overBudget);
  const markdown = [
    "### Code-quality task durations",
    "",
    "| Task | Cache | Duration | Budget | Result |",
    "| --- | --- | ---: | ---: | --- |",
    ...rows.map(
      (row) =>
        `| ${row.taskId} | ${row.cache} | ${row.seconds?.toFixed(3) ?? "—"}s | ${row.budgetSeconds}s | ${row.overBudget ? `${row.status}; OVER BUDGET (warning)` : row.status} |`,
    ),
    "",
  ].join("\n");
  return { rows, violations, markdown };
};

type TrackerOptions = { now?: () => number };
export const createTaskExecutionTracker = ({
  now = Date.now,
}: TrackerOptions = {}) => {
  const started = new Map<string, number>();
  const fragments = new Map<string, string>();
  const observeLine = (source: string) => {
    const line = stripVTControlCharacters(source).trimStart();
    const match =
      /^(?<package>[^\s:]+):(?<task>[^\s]+):\s+cache (?:miss, executing|bypass, force executing)\b/u.exec(
        line,
      );
    const packageName = match?.groups?.["package"];
    const task = match?.groups?.["task"];
    if (packageName === undefined || task === undefined) {
      return;
    }
    const taskId = `${packageName}#${task}`;
    if (!started.has(taskId)) {
      started.set(taskId, now());
    }
  };
  const observe = (chunk: string, channel = "stdout") => {
    const lines = `${fragments.get(channel) ?? ""}${chunk}`.split(/\r?\n/u);
    fragments.set(channel, lines.pop() ?? "");
    for (const line of lines) {
      observeLine(line);
    }
  };
  const flush = () => {
    for (const fragment of fragments.values()) {
      observeLine(fragment);
    }
    fragments.clear();
  };
  const confirm = (summary: TurboRunSummary) => {
    flush();
    for (const task of summary.tasks) {
      if (task.execution !== undefined && task.execution.exitCode !== null) {
        started.delete(task.taskId);
      }
    }
  };
  const unfinished = () => {
    flush();
    return [...started].map(([taskId, start]) => ({
      taskId,
      elapsedSeconds: Math.max(0, now() - start) / 1000,
    }));
  };
  const diagnostics = (reason: string) => {
    const tasks = unfinished();
    return [
      reason,
      ...tasks.map(
        (task) =>
          `${task.taskId}: started without confirmed completion (${task.elapsedSeconds.toFixed(3)}s observed)`,
      ),
    ].join("\n");
  };
  return { observe, confirm, unfinished, diagnostics };
};

type RunBudgetedCheckOptions = {
  command: readonly string[];
  cwd: string;
  timeoutMs: number;
  stallMs?: number;
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
  writeSummary: (markdown: string) => void | Promise<void>;
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
  summary?: "tasks" | "none";
  // Runs end at twice their budget. Only callers that exercise other
  // behaviour with a real process opt out, so wall-clock margins on a busy
  // machine cannot decide their outcome.
  deadline?: "twice-budget" | "none";
};

const PROCESS_GROUP_ENV = "CODE_QUALITY_PROCESS_GROUP";
const TASK_STALL = "Code-quality task stalled";
const TASK_OVERRUN = "Code-quality run exceeded twice its budget";
// Healthy API lint emitted no output for 196.999521 s. Twice that observed gap
// rounds up to 400 s; advancing owned CPU time also counts as progress.
export const TASK_STALL_MS = 400_000;

// Advancing CPU time keeps a quiet compiler alive past its warning budget, but
// a process that spins after its work is done would then never stall. Twice
// the run's budget is the hard bound: past it the run fails whatever it does.
export const TASK_DEADLINE_BUDGETS = 2;

type TaskProgressWatchdogOptions = {
  budgetMs: number;
  stallMs: number;
  now: () => number;
  warn: () => void;
  kill: () => void;
  // A wall-clock bound that progress cannot extend; diagnostics have none.
  deadline?: { ms: number; overrun: () => void };
};
export const createTaskProgressWatchdog = ({
  budgetMs,
  stallMs,
  now,
  warn,
  kill,
  deadline,
}: TaskProgressWatchdogOptions) => {
  const started = now();
  let progressAt = started;
  let warned = false;
  let stalled = false;
  let finished = false;
  let maxGap = 0;
  const warning = () => {
    if (!finished && !warned && now() - started >= budgetMs) {
      warned = true;
      warn();
    }
  };
  return {
    progress: () => {
      if (finished) {
        return;
      }
      maxGap = Math.max(maxGap, now() - progressAt);
      progressAt = now();
    },
    maximumGapMs: () =>
      finished ? maxGap : Math.max(maxGap, now() - progressAt),
    wasStalled: () => stalled,
    idleMs: () => now() - progressAt,
    warn: warning,
    tick: () => {
      if (finished) {
        return;
      }
      warning();
      if (stalled) {
        return;
      }
      if (deadline !== undefined && now() - started >= deadline.ms) {
        stalled = true;
        deadline.overrun();
      } else if (now() - progressAt >= stallMs) {
        stalled = true;
        kill();
      }
    },
    finish: () => {
      warning();
      maxGap = Math.max(maxGap, now() - progressAt);
      finished = true;
    },
  };
};

type ProcessSnapshotOptions = {
  columns: string;
  stallMs: number;
  report: (message: string) => void;
};
// Diagnostics obey the same progress rule as checks; ps has no wall-clock kill.
const processSnapshot = async ({
  columns,
  stallMs,
  report,
}: ProcessSnapshotOptions) => {
  const child = spawn("ps", ["-axo", columns], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startedAt = Date.now();
  let output = "";
  const overflow = new AbortController();
  const watchdog = createTaskProgressWatchdog({
    budgetMs: 1000,
    stallMs,
    now: Date.now,
    warn: () =>
      report(
        `::warning title=task-budget::phase=diagnostic elapsed_ms=${Date.now() - startedAt} budget_ms=1000\n`,
      ),
    kill: () => {
      report(
        `::error title=task-stall::kind=infra class=task-stall phase=diagnostic elapsed_ms=${Date.now() - startedAt} idle_ms=${watchdog.idleMs()}\n`,
      );
      child.kill("SIGKILL");
    },
  });
  const observe = (chunk: Buffer, stdout: boolean) => {
    if (chunk.byteLength === 0) {
      return;
    }
    watchdog.progress();
    if (!stdout) {
      return;
    }
    if (output.length + chunk.length > 2 * 1024 * 1024) {
      overflow.abort();
      return;
    }
    output += chunk.toString();
  };
  child.stdout.on("data", (chunk: Buffer) => observe(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => observe(chunk, false));
  const timer = setInterval(() => watchdog.tick(), Math.min(1000, stallMs / 2));
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0 || watchdog.wasStalled() || overflow.signal.aborted) {
      return invalid(
        `Process snapshot failed: exit=${code} stalled=${watchdog.wasStalled()} overflow=${overflow.signal.aborted}`,
      );
    }
    return output;
  } finally {
    watchdog.finish();
    clearInterval(timer);
  }
};

export const ownedProcessTreeRows = (snapshot: string, group: number) => {
  const rows = snapshot.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s/u.exec(line);
    if (!match) {
      return [];
    }
    return [
      {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        text: line.trim(),
      },
    ];
  });
  const children = new Map<number, number[]>();
  const queue = [group];
  for (const row of rows) {
    const siblings = children.get(row.parent) ?? [];
    siblings.push(row.pid);
    children.set(row.parent, siblings);
    if (row.group === group) {
      queue.push(row.pid);
    }
  }
  const owned = new Set<number>();
  for (const pid of queue) {
    if (owned.has(pid)) {
      continue;
    }
    owned.add(pid);
    for (const child of children.get(pid) ?? []) {
      queue.push(child);
    }
  }
  return rows.filter((row) => owned.has(row.pid)).map((row) => row.text);
};

export const processCpuSnapshot = (snapshot: string, group: number) => {
  const rows = ownedProcessTreeRows(snapshot, group);
  const activity = rows.some((row) => row.split(/\s+/u).at(3)?.startsWith("R"))
    ? "runnable"
    : "waiting";
  const cpu = rows
    .map((row) => {
      const fields = row.split(/\s+/u);
      const processId = fields.at(0);
      const cpuTime = fields.at(4);
      if (processId === undefined || cpuTime === undefined) {
        return invalid("Malformed process CPU snapshot row");
      }
      return `${processId}:${cpuTime}`;
    })
    .toSorted()
    .join("|");
  return { activity, cpu };
};

export const ownedProcessGroupMembers = (snapshot: string, group: number) =>
  snapshot.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trimStart();
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s/u.exec(trimmed);
    const pid = match?.[1];
    const pgid = match?.[2];
    const state = match?.[3];
    const command =
      match === null ? undefined : trimmed.slice(match[0].length).trimStart();
    // Zombies have exited; init reaps adopted grandchildren, not this supervisor.
    if (
      pid === undefined ||
      Number(pgid) !== group ||
      command === undefined ||
      command.length === 0 ||
      Number(pid) === group ||
      state?.startsWith("Z")
    ) {
      return [];
    }
    return [{ pid, command }];
  });

const failureMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (record(cause) && typeof cause["message"] === "string") {
    return cause["message"];
  }
  return String(cause);
};

type ProcessTreeAtSignalOptions = {
  group: number;
  signal: NodeJS.Signals;
  startedAt: number;
  stallMs: number;
  report: (message: string) => void;
};
const processTreeAtSignal = async ({
  group,
  signal,
  startedAt,
  stallMs,
  report,
}: ProcessTreeAtSignalOptions) => {
  const snapshot = await Result.tryPromise(
    async () =>
      await processSnapshot({
        columns: "pid=,ppid=,pgid=,stat=,command=",
        stallMs,
        report,
      }),
  );
  const rows = snapshot.isOk()
    ? ownedProcessTreeRows(snapshot.value, group).join("\n")
    : failureMessage(snapshot.error);
  return `Command process tree at ${signal}: elapsed=${Date.now() - startedAt}ms pgid=${group}\nPID PPID PGID STATE COMMAND\n${rows || "No remaining group members"}\n`;
};

const PROCESS_GROUP_POLL_MS = 50;

type AuditExitedGroupOptions = {
  group: number;
  drainUntil: number;
  stallMs: number;
  report: (diagnostic: string) => void;
  terminate: () => void;
};
const auditExitedProcessGroup = async ({
  group,
  drainUntil,
  stallMs,
  report,
  terminate,
}: AuditExitedGroupOptions) => {
  while (true) {
    const groupSnapshot = await Result.tryPromise(
      async () =>
        await processSnapshot({
          columns: "pid=,pgid=,stat=,command=",
          stallMs,
          report,
        }),
    );
    if (groupSnapshot.isErr()) {
      report(
        `Cannot inspect owned process group ${group}: ${failureMessage(groupSnapshot.error)}\n`,
      );
      terminate();
      return "unavailable" as const;
    }
    const leftovers = ownedProcessGroupMembers(groupSnapshot.value, group);
    if (leftovers.length === 0) {
      return "empty" as const;
    }
    const remainingMs = drainUntil - Date.now();
    if (remainingMs > 0) {
      await Bun.sleep(Math.min(PROCESS_GROUP_POLL_MS, remainingMs));
      continue;
    }
    report(
      leftovers
        .map(
          ({ pid, command: processCommand }) =>
            `Notice: Terminating owned process after leader exit: pid=${pid} pgid=${group} command=${processCommand}\n`,
        )
        .join(""),
    );
    terminate();
    return "terminated" as const;
  }
};

const signalExitCode = (code: number | null, signal: NodeJS.Signals | null) => {
  if (code !== null) {
    return code;
  }
  if (signal === "SIGKILL") {
    return 137;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  if (signal === "SIGINT") {
    return 130;
  }
  return 1;
};

type SignalOwnedGroupOptions = {
  signal: NodeJS.Signals;
  termination: string | undefined;
  ownsGroup: boolean;
  child: Pick<ChildProcess, "pid" | "kill">;
  inspectedSignals: Set<NodeJS.Signals>;
  pendingDiagnostics: Promise<void>[];
  startedAt: number;
  stallMs: number;
  reportDiagnostic: (message: string) => void;
};
const signalOwnedGroup = ({
  signal,
  termination,
  ownsGroup,
  child,
  inspectedSignals,
  pendingDiagnostics,
  startedAt,
  stallMs,
  reportDiagnostic,
}: SignalOwnedGroupOptions) => {
  if (
    termination !== undefined &&
    ownsGroup &&
    process.platform !== "win32" &&
    child.pid !== undefined &&
    !inspectedSignals.has(signal)
  ) {
    inspectedSignals.add(signal);
    pendingDiagnostics.push(
      processTreeAtSignal({
        group: child.pid,
        signal,
        startedAt,
        stallMs,
        report: reportDiagnostic,
      }).then(reportDiagnostic),
    );
  }
  const attempt = Result.try({
    try: () => {
      if (
        ownsGroup &&
        child.pid !== undefined &&
        process.platform !== "win32"
      ) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    },
    catch: (cause) => cause,
  });
  if (
    attempt.isErr() &&
    !(record(attempt.error) && attempt.error["code"] === "ESRCH")
  ) {
    const diagnostic = `Cannot terminate command group: ${failureMessage(attempt.error)}\n`;
    reportDiagnostic(diagnostic);
  }
};

type TaskMonitorOptions = {
  budgetMs: number;
  stallMs: number;
  startedAt: number;
  pid: number | undefined;
  reportDiagnostic: (message: string) => void;
  terminate: (reason: string) => void;
  deadline: "twice-budget" | "none";
};
const createTaskMonitor = ({
  budgetMs,
  stallMs,
  startedAt,
  pid,
  reportDiagnostic,
  terminate,
  deadline,
}: TaskMonitorOptions) => {
  const telemetry = () =>
    `elapsed_ms=${Date.now() - startedAt} budget_ms=${budgetMs} stall_ms=${stallMs} max_progress_gap_ms=${watchdog.maximumGapMs()}`;
  const watchdog = createTaskProgressWatchdog({
    budgetMs,
    stallMs,
    now: Date.now,
    warn: () =>
      reportDiagnostic(`::warning title=task-budget::${telemetry()}\n`),
    kill: () => {
      reportDiagnostic(
        `::error title=task-stall::kind=infra class=task-stall ${telemetry()} idle_ms=${watchdog.idleMs()}\n`,
      );
      terminate(TASK_STALL);
    },
    ...(deadline === "twice-budget"
      ? {
          deadline: {
            ms: budgetMs * TASK_DEADLINE_BUDGETS,
            overrun: () => {
              reportDiagnostic(
                `::error title=task-overrun::kind=infra class=task-overrun ${telemetry()} idle_ms=${watchdog.idleMs()}\n`,
              );
              terminate(TASK_OVERRUN);
            },
          },
        }
      : {}),
  });
  let previousCpu: string | undefined;
  let progressProbeWarning = false;
  let probing: Promise<void> | undefined;
  const completion = new AbortController();
  let lastProbe = startedAt;
  const probeCpu = async () => {
    const cpuSnapshot = await Result.tryPromise(async () => {
      const snapshot = await processSnapshot({
        columns: "pid=,ppid=,pgid=,stat=,time=,command=",
        stallMs,
        report: reportDiagnostic,
      });
      if (pid === undefined) {
        return processCpuSnapshot("", -1);
      }
      return processCpuSnapshot(snapshot, pid);
    });
    if (completion.signal.aborted) {
      return;
    }
    if (cpuSnapshot.isErr()) {
      // Failed observation cannot prove a CPU stall. Surface it once and use
      // the job deadline, rather than killing a potentially busy compiler.
      if (!progressProbeWarning) {
        progressProbeWarning = true;
        reportDiagnostic(
          `::warning title=task-progress-probe::Cannot observe task CPU progress: ${failureMessage(cpuSnapshot.error)}; job deadline remains the outer bound\n`,
        );
      }
      return;
    }
    const { activity, cpu } = cpuSnapshot.value;
    if (
      activity === "runnable" ||
      (previousCpu !== undefined && cpu !== previousCpu)
    ) {
      watchdog.progress();
    }
    previousCpu = cpu;
    watchdog.tick();
  };
  const timer = setInterval(
    () => {
      if (completion.signal.aborted || probing !== undefined) {
        return;
      }
      watchdog.warn();
      if (process.platform === "win32") {
        watchdog.tick();
        return;
      }
      const probeInterval = Math.min(5000, stallMs / 2);
      if (watchdog.idleMs() < probeInterval) {
        watchdog.tick();
        return;
      }
      if (Date.now() - lastProbe < probeInterval) {
        return;
      }
      lastProbe = Date.now();
      probing = probeCpu().finally(() => {
        probing = undefined;
      });
    },
    Math.min(1000, stallMs / 2),
  );

  const stop = () => {
    completion.abort();
    clearInterval(timer);
    watchdog.finish();
  };
  return {
    progress: watchdog.progress,
    telemetry,
    stop,
    settled: async () => {
      await probing;
    },
  };
};

export const runBudgetedCheck = async ({
  command,
  cwd,
  timeoutMs,
  stallMs = TASK_STALL_MS,
  writeStdout,
  writeStderr,
  writeSummary,
  graceMs = 1000,
  env,
  summary = "tasks",
  deadline = "twice-budget",
}: RunBudgetedCheckOptions) => {
  const executable = command.at(0);
  if (
    executable === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isFinite(stallMs) ||
    stallMs <= 0
  ) {
    return invalid(
      "A command, nonnegative warning budget and positive stall interval are required",
    );
  }
  const turbo =
    summary === "tasks" &&
    command.some((argument) => path.basename(argument) === "turbo");
  const runDirectory = path.join(cwd, ".turbo", "runs");
  const snapshot = await Result.tryPromise({
    try: async () => await readdir(runDirectory),
    catch: (cause) => cause,
  });
  if (
    snapshot.isErr() &&
    !(record(snapshot.error) && snapshot.error["code"] === "ENOENT")
  ) {
    return invalid(
      `Cannot inspect Turbo summaries: ${failureMessage(snapshot.error)}`,
    );
  }
  const previous = new Set(snapshot.isOk() ? snapshot.value : []);
  const tracker = createTaskExecutionTracker();
  let output = "";
  const reportDiagnostic = (diagnostic: string) => {
    output += diagnostic;
    writeStderr(diagnostic);
  };
  let termination: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  // A delegated supervisor shares the outer group so its descendants cannot
  // outlive the owner when equal cleanup deadlines race.
  const ownsGroup = process.env[PROCESS_GROUP_ENV] !== "inherited";
  const child = spawn(executable, command.slice(1), {
    cwd,
    detached: ownsGroup && process.platform !== "win32",
    env: { ...process.env, ...env, [PROCESS_GROUP_ENV]: "inherited" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inspectedSignals = new Set<NodeJS.Signals>();
  const pendingDiagnostics: Promise<void>[] = [];
  const killGroup = (signal: NodeJS.Signals) =>
    signalOwnedGroup({
      signal,
      termination,
      ownsGroup,
      child,
      inspectedSignals,
      pendingDiagnostics,
      startedAt,
      stallMs,
      reportDiagnostic,
    });
  const terminate = (reason: string) => {
    if (termination !== undefined) {
      return;
    }
    termination = reason;
    reportDiagnostic(`${reason}\n`);
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), graceMs);
  };
  const onTerm = () => terminate("Code-quality command interrupted by SIGTERM");
  const onInt = () => terminate("Code-quality command interrupted by SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const monitor = createTaskMonitor({
    budgetMs: timeoutMs,
    stallMs,
    startedAt,
    pid: child.pid,
    reportDiagnostic,
    terminate,
    deadline,
  });
  const tee = (chunk: Buffer, channel: "stdout" | "stderr") => {
    const text = chunk.toString();
    if (chunk.byteLength > 0) {
      monitor.progress();
    }
    output += text;
    tracker.observe(text, channel);
    (channel === "stdout" ? writeStdout : writeStderr)(text);
  };
  child.stdout.on("data", (chunk: Buffer) => tee(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => tee(chunk, "stderr"));
  let cleanupRequired = false;
  let groupAudit: "empty" | "terminated" | "unavailable" = "empty";
  let cleanupGrace: Promise<void> | undefined;
  const terminateLeftovers = () => {
    killGroup("SIGTERM");
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    cleanupGrace = new Promise<void>((resolve) => {
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        resolve();
      }, graceMs);
    });
  };
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      reportDiagnostic(`${String(error)}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      // A real command failure takes precedence over a later cleanup stall.
      if (signal === null && code !== null && code !== 0) {
        monitor.stop();
      }
      resolve(signalExitCode(code, signal));
    });
  });
  const endedAt = Date.now();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const pipesDrained = Promise.race([
    closed,
    new Promise<void>((resolve) => {
      drainTimer = setTimeout(() => {
        cleanupRequired = true;
        const diagnostic =
          "Command pipes remained open after leader exit; terminating owned group and closing pipes\n";
        reportDiagnostic(diagnostic);
        killGroup("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        resolve();
      }, graceMs + 1000);
    }),
  ]).finally(() => clearTimeout(drainTimer));
  if (ownsGroup && child.pid !== undefined && process.platform !== "win32") {
    groupAudit = await auditExitedProcessGroup({
      group: child.pid,
      // Let short-lived descendants finish within the existing termination grace.
      drainUntil: endedAt + graceMs,
      stallMs,
      report: reportDiagnostic,
      terminate: terminateLeftovers,
    });
    cleanupRequired = groupAudit !== "empty" || cleanupRequired;
  }
  if (cleanupGrace !== undefined) {
    await cleanupGrace;
  }
  await pipesDrained;
  if (cleanupRequired) {
    killGroup("SIGKILL");
  }
  monitor.stop();
  await monitor.settled();
  if (termination !== undefined) {
    killGroup("SIGKILL");
  }
  if (killTimer !== undefined) {
    clearTimeout(killTimer);
  }
  await Promise.all(pendingDiagnostics);
  reportDiagnostic(
    `Code-quality timing: ${monitor.telemetry()} child_exit=${exitCode}\n`,
  );
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  return await finishBudgetedCheck({
    turbo,
    runDirectory,
    previous,
    tracker,
    exitCode: groupAudit === "unavailable" && exitCode === 0 ? 1 : exitCode,
    termination,
    output,
    writeStderr,
    writeSummary,
    startedAt,
    endedAt,
  });
};

type FinishBudgetedCheckOptions = {
  turbo: boolean;
  runDirectory: string;
  previous: Set<string>;
  tracker: ReturnType<typeof createTaskExecutionTracker>;
  exitCode: number;
  termination: string | undefined;
  output: string;
  writeStderr: (chunk: string) => void;
  writeSummary: RunBudgetedCheckOptions["writeSummary"];
  startedAt: number;
  endedAt: number;
};
type BudgetedCheckResult = {
  exitCode: number;
  output: string;
  outcome: "completed" | "stalled" | "interrupted";
};
const finishBudgetedCheck = async ({
  turbo,
  runDirectory,
  previous,
  tracker,
  exitCode,
  termination,
  output: initialOutput,
  writeStderr,
  writeSummary,
  startedAt,
  endedAt,
}: FinishBudgetedCheckOptions): Promise<BudgetedCheckResult> => {
  let output = initialOutput;
  const completedReport = async () => {
    const announced = stripVTControlCharacters(initialOutput)
      .split("\n")
      .flatMap((source) => {
        const line = source.trim();
        if (!/^Summary:\s/u.test(line)) {
          return [];
        }
        const file = line.slice("Summary:".length).trim();
        return file.endsWith(".json") ? [file] : [];
      })
      .map((file) => path.resolve(runDirectory, "..", "..", file));
    const candidates: string[] = [];
    if (announced.length > 0) {
      const canonicalDirectory = await realpath(runDirectory);
      const freshAnnouncements = [...new Set(announced)].filter(
        (file) => !previous.has(path.basename(file)),
      );
      const canonicalAnnouncements = await Promise.all(
        freshAnnouncements.map(async (file) => await realpath(file)),
      );
      candidates.push(
        ...new Set(
          canonicalAnnouncements.filter(
            (file) =>
              path.dirname(file) === canonicalDirectory &&
              !previous.has(path.basename(file)),
          ),
        ),
      );
    }
    if (candidates.length !== 1) {
      return invalid(
        `Expected one fresh Turbo summary announced by this command, found ${candidates.length}`,
      );
    }
    const file = candidates.at(0);
    if (file === undefined) {
      return invalid("Turbo summary filename missing");
    }
    const value: unknown = JSON.parse(await readFile(file, "utf-8"));
    const summary = parseTurboRunSummary(value);
    if (
      summary.execution.startTime < startedAt ||
      summary.execution.endTime > endedAt
    ) {
      return invalid(
        "Turbo summary execution interval does not belong to this command",
      );
    }
    tracker.confirm(summary);
    const report = evaluateTaskBudgets({ summary });
    await writeSummary(report.markdown);
    return report;
  };
  if (termination !== undefined) {
    if (turbo) {
      const completed = await Result.tryPromise(completedReport);
      if (completed.isErr()) {
        const diagnostic = `Turbo summary after interruption unavailable: ${failureMessage(completed.error)}\n`;
        output += diagnostic;
        writeStderr(diagnostic);
      }
    }
    const tasks = tracker.unfinished();
    const markdown = [
      "### Interrupted code-quality tasks",
      "",
      "| Task | Observed elapsed | Budget | State |",
      "| --- | ---: | ---: | --- |",
      ...tasks.map(
        (task) =>
          `| ${task.taskId} | ${task.elapsedSeconds.toFixed(3)}s | ${DEFAULT_TASK_BUDGETS.overrides[task.taskId] ?? DEFAULT_TASK_BUDGETS.defaultSeconds}s | Started without confirmed completion |`,
      ),
      "",
    ].join("\n");
    const written = await Result.tryPromise(async () => writeSummary(markdown));
    if (written.isErr()) {
      const diagnostic = `Cannot write interrupted task summary: ${failureMessage(written.error)}\n`;
      output += diagnostic;
      writeStderr(diagnostic);
    }
    const diagnostic = `${tracker.diagnostics(termination)}\n`;
    output += diagnostic;
    writeStderr(diagnostic);
    if (termination === TASK_STALL) {
      const annotation = `::error title=task-stall::kind=infra class=task-stall elapsed_ms=${endedAt - startedAt}\n`;
      output += annotation;
      writeStderr(annotation);
    }
    return {
      exitCode: 124,
      output,
      outcome:
        termination === TASK_STALL || termination === TASK_OVERRUN
          ? "stalled"
          : "interrupted",
    };
  }
  if (!turbo) {
    return { exitCode, output, outcome: "completed" };
  }
  const checked = await Result.tryPromise(async () => {
    const report = await completedReport();
    for (const task of report.violations) {
      const warning = `::warning title=task-budget::task=${task.taskId} elapsed_ms=${Math.round((task.seconds ?? 0) * 1000)} budget_ms=${task.budgetSeconds * 1000}; ${task.seconds?.toFixed(3) ?? "unknown"}s exceeds ${task.budgetSeconds}s task budget\n`;
      output += warning;
      writeStderr(warning);
    }
  });
  if (checked.isErr()) {
    const diagnostic = `${tracker.diagnostics(`Turbo task budget report unavailable or failed: ${failureMessage(checked.error)}`)}\n`;
    output += diagnostic;
    writeStderr(diagnostic);
    return {
      exitCode: exitCode === 0 ? 1 : exitCode,
      output,
      outcome: "completed",
    };
  }
  return { exitCode, output, outcome: "completed" };
};
