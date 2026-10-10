import { panic, Result, TaggedError } from "better-result";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { printError } from "@stll/errors";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";

// A measured CI solo batch (254 chat turn tests) took 250.9s. Ten minutes
// gives it more than twice that headroom, while bounding imports, snapshot
// builds and process cleanup that Bun's per-test timeout cannot protect.
const CHILD_TIMEOUT_MS = 10 * 60_000;
// CI allows 25m including checkout/install; stop 20m after runner startup
// to reserve time for termination, diagnostics and artifact upload.
const RUNNER_DEADLINE_MS = 20 * 60_000;
const CHILD_STOP_GRACE_MS = 10_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 16 * 1024;
const TIMEOUT_EXIT_CODE = 124;

export const API_TEST_CHILD_TIMEOUT_MS_ENV = "API_TEST_CHILD_TIMEOUT_MS";
export const API_TEST_RUNNER_DEADLINE_MS_ENV = "API_TEST_RUNNER_DEADLINE_MS";

export const testProcessBudgets = (
  environment: NodeJS.ProcessEnv,
  defaultDeadlineMs = RUNNER_DEADLINE_MS,
) => {
  const readLimit = (name: string, fallback: number) => {
    const value = environment[name];
    if (value === undefined) {
      return fallback;
    }
    if (!/^\d+$/u.test(value)) {
      panic(`${name} must be an integer of at least two`);
    }
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 2) {
      panic(`${name} must be an integer of at least two`);
    }
    return limit;
  };
  const childTimeoutMs = readLimit(
    API_TEST_CHILD_TIMEOUT_MS_ENV,
    CHILD_TIMEOUT_MS,
  );
  const deadlineMs = readLimit(
    API_TEST_RUNNER_DEADLINE_MS_ENV,
    defaultDeadlineMs,
  );
  if (childTimeoutMs >= deadlineMs) {
    panic("API test child budget must be below the runner deadline");
  }
  return { childTimeoutMs, deadlineMs };
};

class TestProcessOperationError extends TaggedError(
  "TestProcessOperationError",
)<{
  message: string;
  cause: unknown;
}> {}

const operationError = (cause: unknown) =>
  new TestProcessOperationError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

type ProcessIdentity = {
  kind: "batch" | "snapshot" | "baseline" | "snapshot-validation";
  label: string;
  files: readonly string[];
  lane: number;
};

type ActiveProcess = {
  identity: ProcessIdentity;
  pid: number;
  startedAt: string;
  logPath: string;
  junitPath: string;
  child: Bun.Subprocess;
  tail: Buffer;
  cancelStreams: () => void;
};

type SupervisorOptions = {
  directory: string;
  onProgress: (text: string) => void;
  onDiagnostic: (text: string) => void;
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
  childTimeoutMs?: number;
  deadlineMs?: number;
  stopGraceMs?: number;
  maxLogBytes?: number;
  tailBytes?: number;
};

type RunProcessOptions = {
  command: (junitPath: string) => string[];
  cwd: string;
  env: Record<string, string | undefined>;
  identity: ProcessIdentity;
  mode: "buffered" | "stream" | "discard";
};

/** Owns the deadline and evidence for every process the API test runner starts. */
export class TestProcessSupervisor {
  private readonly shutdown = new AbortController();
  readonly signal = this.shutdown.signal;

  // A method read: a `this.signal.aborted` check narrows to false for the
  // rest of `run()`, though a stop can abort it across the awaits.
  private stopped(): boolean {
    return this.signal.aborted;
  }
  private readonly active = new Map<number, ActiveProcess>();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private escalation: ReturnType<typeof setTimeout> | undefined;
  private failure: string | null = null;
  private sequence = 0;
  private readonly childTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly maxLogBytes: number;
  private readonly tailBytes: number;
  private readonly options: SupervisorOptions;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.childTimeoutMs = options.childTimeoutMs ?? CHILD_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? CHILD_STOP_GRACE_MS;
    this.maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
    this.tailBytes = options.tailBytes ?? TAIL_BYTES;
    for (const limit of [
      this.childTimeoutMs,
      this.stopGraceMs,
      this.maxLogBytes,
      this.tailBytes,
      options.deadlineMs ?? RUNNER_DEADLINE_MS,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 2) {
        panic("Test process limits must be integers of at least two");
      }
    }
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.writeRegistry("active.json");
    this.deadline = setTimeout(() => {
      this.stop("API test runner wall-clock deadline exceeded");
    }, options.deadlineMs ?? RUNNER_DEADLINE_MS);
    this.deadline.unref();
  }

  private writeRegistry(filename: string): void {
    const registry = {
      failure: this.failure,
      processes: [...this.active.values()].map(
        ({ identity, pid, startedAt, logPath, junitPath }) => ({
          ...identity,
          pid,
          startedAt,
          logPath,
          junitPath,
        }),
      ),
    };
    const destination = path.join(this.options.directory, filename);
    writeFileSync(`${destination}.tmp`, JSON.stringify(registry, null, 2), {
      mode: 0o600,
    });
    renameSync(`${destination}.tmp`, destination);
  }

  private diagnose(text: string): void {
    const reported = Result.try({
      try: () => this.options.onDiagnostic(text),
      catch: operationError,
    });
    if (reported.isErr()) {
      printError(text, "Diagnostic callback failed:", reported.error);
    }
  }

  private signalProcess(
    { child, pid }: ActiveProcess,
    signal: NodeJS.Signals,
  ): void {
    const signalled = Result.try({
      try: () => {
        if (process.platform === "win32") {
          child.kill(signal);
          return;
        }
        // Each POSIX child starts its own session, so this group belongs to
        // this invocation, including descendants that retain the output pipes.
        process.kill(-pid, signal);
      },
      catch: operationError,
    });
    if (signalled.isErr()) {
      const error = signalled.error.cause;
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return;
      }
      this.diagnose(
        `Could not send ${signal} to PID ${pid}: ${signalled.error.message}`,
      );
    }
  }

  stop(reason: string): void {
    if (this.signal.aborted) {
      return;
    }
    this.failure = reason;
    this.shutdown.abort();
    const details = [...this.active.values()]
      .map(
        ({ identity, pid, logPath, tail }) =>
          `${identity.kind} ${identity.label}, lane ${identity.lane}, PID ${pid}: ${identity.files.join(", ")}\n${logPath} tail:\n${tail.toString("utf-8")}`,
      )
      .join("\n");
    this.diagnose(`${reason}; active API test processes:\n${details}`);
    const saved = Result.try({
      try: () => {
        this.writeRegistry("failure.json");
        this.writeRegistry("active.json");
      },
      catch: operationError,
    });
    if (saved.isErr()) {
      this.diagnose(
        `Could not persist stopped process registry: ${saved.error.message}`,
      );
    }
    for (const entry of this.active.values()) {
      this.signalProcess(entry, "SIGTERM");
    }
    this.escalation = setTimeout(() => {
      this.kill();
    }, this.stopGraceMs);
  }

  kill(): void {
    for (const entry of this.active.values()) {
      this.signalProcess(entry, "SIGKILL");
      // A descendant can hold a pipe open after its parent exits. Once the
      // stop grace expires, pipe draining must not hold the runner forever.
      entry.cancelStreams();
    }
    this.active.clear();
  }

  dispose(): void {
    this.kill();
    clearTimeout(this.deadline);
    clearTimeout(this.escalation);
  }

  async run({ command, cwd, env, identity, mode }: RunProcessOptions) {
    if (this.signal.aborted) {
      return { exitCode: TIMEOUT_EXIT_CODE, usage: undefined, output: "" };
    }
    const id = ++this.sequence;
    const logPath = path.join(this.options.directory, `${id}.log`);
    const junitPath = path.join(this.options.directory, `${id}.xml`);
    writeFileSync(logPath, "", { mode: 0o600 });
    const child = Bun.spawn({
      cmd: command(junitPath),
      cwd,
      env,
      detached: process.platform !== "win32",
      stdin: mode === "stream" ? "inherit" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = child.stdout.getReader();
    const stderr = child.stderr.getReader();
    const cancelStreams = () => {
      // Cancellation is only used after a stop. Report a failed cancellation
      // at this process boundary instead of losing it to an unhandled promise.
      for (const reader of [stdout, stderr]) {
        void reader.cancel().catch((error: unknown) => {
          this.diagnose(
            `Could not close PID ${child.pid} pipe: ${String(error)}`,
          );
        });
      }
    };
    const entry: ActiveProcess = {
      identity,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      logPath,
      junitPath,
      child,
      tail: Buffer.alloc(0),
      cancelStreams,
    };
    this.active.set(id, entry);

    let logBytes = 0;
    const segmentBytes = Math.floor(this.maxLogBytes / 2);
    const parts: string[] = [];
    let bufferedCharacters = 0;
    const outputState = { truncated: false };
    const buffer = (text: string) => {
      parts.push(text);
      bufferedCharacters += text.length;
      while (bufferedCharacters > this.maxLogBytes) {
        const first =
          parts.at(0) ?? panic("Buffered output must contain a chunk");
        const removed = Math.min(
          first.length,
          bufferedCharacters - this.maxLogBytes,
        );
        if (removed === first.length) {
          parts.shift();
        } else {
          parts[0] = first.slice(removed);
        }
        bufferedCharacters -= removed;
        outputState.truncated = true;
      }
    };
    const collect = async (
      reader: typeof stdout,
      forward: (text: string) => void,
    ) => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = Buffer.from(value);
        entry.tail = Buffer.from(
          Buffer.concat([entry.tail, chunk]).subarray(-this.tailBytes),
        );
        // Two rolling segments bound disk usage while retaining recent progress.
        const retained = chunk.subarray(-segmentBytes);
        if (logBytes + retained.length > segmentBytes) {
          renameSync(logPath, `${logPath.replace(/\.log$/u, "")}.previous.log`);
          writeFileSync(logPath, "", { mode: 0o600 });
          logBytes = 0;
        }
        appendFileSync(logPath, retained);
        logBytes += retained.length;
        const text = decoder.decode(value, { stream: true });
        switch (mode) {
          case "buffered":
            buffer(text);
            break;
          case "stream":
            forward(text);
            break;
          case "discard":
            break;
          default:
            mode satisfies never;
            panic("Unhandled test process output mode");
        }
      }
      const remaining = decoder.decode();
      if (mode === "buffered") {
        buffer(remaining);
      } else if (mode === "stream" && remaining !== "") {
        forward(remaining);
      }
    };
    const watchdog = setTimeout(() => {
      this.stop(
        `${identity.kind} ${identity.label} exceeded ${this.childTimeoutMs}ms wall-clock budget`,
      );
    }, this.childTimeoutMs);
    const streams: Promise<void>[] = [];
    try {
      this.writeRegistry("active.json");
      this.options.onProgress(
        `${entry.startedAt} API ${identity.kind} start: ${identity.label}; ` +
          `lane ${identity.lane}; PID ${entry.pid}; files: ${identity.files.join(", ")}`,
      );
      streams.push(
        collect(stdout, this.options.onStdout),
        collect(stderr, this.options.onStderr),
      );
      await Promise.all([child.exited, ...streams]);
      const result = {
        exitCode:
          this.failure === null ? childExitStatus(child) : TIMEOUT_EXIT_CODE,
        usage: child.resourceUsage(),
        output: `${outputState.truncated ? "[API batch output truncated; see rolling raw logs]\n" : ""}${parts.join("").trimEnd()}`,
      };
      return result;
    } catch (error) {
      // This is the child-process boundary: a pipe, disk or progress callback
      // failure must reap the child before propagating to the runner.
      this.stop(`${identity.kind} ${identity.label} failed: ${String(error)}`);
      await Promise.allSettled([child.exited, ...streams]);
      throw error;
    } finally {
      clearTimeout(watchdog);
      // A stopped leader may exit before its descendants, which still need escalation.
      if (!this.stopped()) {
        this.active.delete(id);
      }
      const saved = Result.try({
        try: () => this.writeRegistry("active.json"),
        catch: operationError,
      });
      if (saved.isErr()) {
        this.diagnose(
          `Could not persist active process registry: ${saved.error.message}`,
        );
      }
      if (this.active.size === 0) {
        clearTimeout(this.escalation);
      }
    }
  }
}
