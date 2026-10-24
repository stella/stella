import { panic, Result, TaggedError } from "better-result";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";

export const FLAKE_GATE_TRIAL_ENV = "FLAKE_GATE_TRIAL";
export type FlakeCleanup =
  | { type: "linux-proc-token"; note: "cleanup: Linux /proc trial ownership" }
  | { type: "best-effort"; platform: string; note: "cleanup: best-effort" };

export const cleanupCapability = (platform = process.platform): FlakeCleanup =>
  platform === "linux"
    ? { type: "linux-proc-token", note: "cleanup: Linux /proc trial ownership" }
    : { type: "best-effort", platform, note: "cleanup: best-effort" };

class FlakeProcessError extends TaggedError("FlakeProcessError")<{
  message: string;
  cause?: unknown;
}> {}

const OUTPUT_TAIL_CHARACTERS = 65_536;
const OUTPUT_LINE_CHARACTERS = 65_536;

type ReadOutputOptions = {
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">;
  onLine?: ((line: string) => void) | undefined;
};
type OutputParserState = { pending: string; failure: FlakeProcessError | null };

const readOutput = async ({ reader, onLine }: ReadOutputOptions) => {
  const decoder = new TextDecoder();
  let tail = "";
  const parser: OutputParserState = { pending: "", failure: null };
  const consume = (text: string) => {
    tail = (tail + text).slice(-OUTPUT_TAIL_CHARACTERS);
    if (!onLine || parser.failure) {
      return;
    }
    parser.pending += text;
    const lines = parser.pending.split("\n");
    parser.pending = lines.pop() ?? "";
    const parsed = Result.try({
      try: () => {
        for (const line of lines) {
          if (line.length > OUTPUT_LINE_CHARACTERS) {
            throw new FlakeProcessError({
              message: "Flake listing contains an oversized line",
            });
          }
          onLine(line.replace(/\r$/u, ""));
        }
        if (parser.pending.length > OUTPUT_LINE_CHARACTERS) {
          throw new FlakeProcessError({
            message: "Flake listing contains an oversized line",
          });
        }
      },
      catch: (cause) =>
        new FlakeProcessError({
          message:
            cause instanceof Error
              ? cause.message
              : "Cannot parse flake process output",
          cause,
        }),
    });
    if (parsed.isErr()) {
      parser.failure = parsed.error;
      parser.pending = "";
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    consume(decoder.decode(chunk.value, { stream: true }));
  }
  consume(decoder.decode());
  if (onLine && !parser.failure && parser.pending !== "") {
    consume("\n");
  }
  return { tail, failure: parser.failure };
};

type RunFlakeProcessOptions = {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  deadline: number;
  onStdoutLine?: ((line: string) => void) | undefined;
};
export type FlakeProcessOutcome =
  | { type: "completed"; status: number; stdout: string; stderr: string }
  | { type: "timeout" };

/** Every discovery and execution subprocess shares its caller's trial deadline. */
export const runFlakeProcess = async ({
  command,
  cwd,
  env,
  deadline,
  onStdoutLine,
}: RunFlakeProcessOptions): Promise<FlakeProcessOutcome> => {
  if (process.platform === "win32") {
    throw new FlakeProcessError({
      message: "Flake gate process deadlines require POSIX",
    });
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    return { type: "timeout" };
  }
  const token = randomUUID();
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, ...env, [FLAKE_GATE_TRIAL_ENV]: token },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      Math.max(1, Math.floor(deadline - performance.now())),
    );
  });
  const completed = Result.tryPromise(async () =>
    Promise.all([
      child.exited,
      readOutput({ reader: stdoutReader, onLine: onStdoutLine }),
      readOutput({ reader: stderrReader }),
    ]),
  );
  const captured = await Promise.race([completed, timedOut]);
  clearTimeout(timer);
  if (captured === "timeout" || captured.isErr()) {
    const terminated = await Result.tryPromise(async () =>
      cleanupFlakeTrial({ rootPid: child.pid, token }),
    );
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      completed,
      new Promise<"undrained">((resolve) => {
        cleanupTimer = setTimeout(() => resolve("undrained"), 1000);
      }),
    ]);
    clearTimeout(cleanupTimer);
    const cancelled = await Result.tryPromise(async () =>
      Promise.all([stdoutReader.cancel(), stderrReader.cancel()]),
    );
    if (cancelled.isErr()) {
      throw cancelled.error;
    }
    if (terminated.isErr()) {
      throw terminated.error;
    }
    if (drained === "undrained") {
      throw new FlakeProcessError({
        message:
          "Timed-out runner descendants retained output pipes after cleanup",
      });
    }
    if (captured !== "timeout") {
      throw captured.error;
    }
    return { type: "timeout" };
  }
  if (process.platform === "linux") {
    await cleanupFlakeTrial({ rootPid: child.pid, token });
  }
  const [status, stdout, stderr] = captured.value;
  // Parse errors are reported after EOF and process cleanup, never while a child owns pipes.
  if (stdout.failure) {
    throw stdout.failure;
  }
  if (stderr.failure) {
    throw stderr.failure;
  }
  return {
    type: "completed",
    status,
    stdout: stdout.tail,
    stderr: stderr.tail,
  };
};

const signalOwnedProcess = (pid: number, signal: NodeJS.Signals) => {
  const signalled = Result.try({
    try: () => process.kill(pid, signal),
    catch: (cause) =>
      new FlakeProcessError({
        message: `Cannot send ${signal} to owned process ${pid}`,
        cause,
      }),
  });
  if (signalled.isOk()) {
    return;
  }
  const cause = signalled.error.cause;
  if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
    return;
  }
  throw signalled.error;
};

/** Freeze before discovery so a detached grandchild cannot fork past the timeout snapshot. */
const terminateFlakeProcessTree = (rootPid: number) => {
  if (rootPid <= 1 || rootPid === process.pid) {
    panic("Invalid flake process root");
  }
  const owned = new Set([rootPid]);
  const stopped = Result.try(() => {
    signalOwnedProcess(rootPid, "SIGSTOP");
    for (;;) {
      const snapshot = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], {
        timeout: 1000,
      });
      if (!snapshot.success) {
        throw new FlakeProcessError({
          message: "Cannot inspect flake runner descendants",
        });
      }
      let discovered = 0;
      for (const line of snapshot.stdout.toString().trim().split("\n")) {
        const [pidText, parentText] = line.trim().split(/\s+/u);
        const pid = Number(pidText);
        const parent = Number(parentText);
        if (
          !Number.isSafeInteger(pid) ||
          pid <= 1 ||
          !owned.has(parent) ||
          owned.has(pid)
        ) {
          continue;
        }
        owned.add(pid);
        signalOwnedProcess(pid, "SIGSTOP");
        discovered += 1;
      }
      if (discovered === 0) {
        break;
      }
    }
  });
  // Always release stopped processes, including when inspection fails.
  const failures: string[] = [];
  for (const pid of [...owned].toReversed()) {
    const killed = Result.try(() => signalOwnedProcess(pid, "SIGKILL"));
    if (killed.isErr()) {
      failures.push(killed.error.message);
    }
  }
  if (stopped.isErr()) {
    failures.push(stopped.error.message);
  }
  if (failures.length > 0) {
    throw new FlakeProcessError({ message: failures.join("; ") });
  }
};

type MarkedProcessOptions = { procRoot: string; token: string };
const markedProcessIds = ({ procRoot, token }: MarkedProcessOptions) => {
  const marker = `${FLAKE_GATE_TRIAL_ENV}=${token}`;
  const pids: number[] = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) {
      continue;
    }
    const environ = Result.try(() =>
      readFileSync(path.join(procRoot, entry, "environ")),
    );
    if (environ.isOk()) {
      // Exact NUL-delimited entries avoid matching another variable's value.
      if (environ.value.toString().split("\0").includes(marker)) {
        pids.push(pid);
      }
      continue;
    }
    const cause = environ.error.cause;
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(String(cause.code))
    ) {
      continue;
    }
    throw new FlakeProcessError({
      message: `Cannot inspect trial ownership for process ${pid}`,
      cause: environ.error,
    });
  }
  return pids;
};

const processHasExited = (procRoot: string, pid: number) => {
  const status = Result.try(() =>
    readFileSync(path.join(procRoot, String(pid), "status"), "utf-8"),
  );
  if (status.isOk()) {
    return /^State:\s+[ZX]\b/mu.test(status.value);
  }
  const cause = status.error.cause;
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ESRCH")
  ) {
    return true;
  }
  throw new FlakeProcessError({
    message: `Cannot confirm exit for owned process ${pid}`,
    cause: status.error,
  });
};

type CleanupFlakeTrialOptions = {
  rootPid: number;
  token: string;
  platform?: NodeJS.Platform;
  procRoot?: string;
  signal?: typeof signalOwnedProcess;
};

/** Environment ownership survives setsid and reparenting; test descendants inherit it. */
export const cleanupFlakeTrial = async ({
  rootPid,
  token,
  platform = process.platform,
  procRoot = "/proc",
  signal = signalOwnedProcess,
}: CleanupFlakeTrialOptions): Promise<FlakeCleanup> => {
  if (
    !token ||
    token.includes("\0") ||
    rootPid <= 1 ||
    rootPid === process.pid
  ) {
    panic("Invalid flake trial ownership");
  }
  if (platform !== "linux") {
    terminateFlakeProcessTree(rootPid);
    return cleanupCapability(platform);
  }
  const maxPasses = 20;
  const observed = new Set<number>();
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const pids = markedProcessIds({ procRoot, token });
    if (
      pids.length === 0 &&
      [...observed].every((pid) => processHasExited(procRoot, pid))
    ) {
      return cleanupCapability(platform);
    }
    for (const pid of pids) {
      observed.add(pid);
    }
    const stopped = Result.try(() => {
      for (const pid of pids) {
        signal(pid, "SIGSTOP");
      }
    });
    const failures: string[] = [];
    // Attempt every kill even when freezing or another kill failed.
    for (const pid of pids) {
      const killed = Result.try(() => signal(pid, "SIGKILL"));
      if (killed.isErr()) {
        failures.push(killed.error.message);
      }
    }
    if (stopped.isErr()) {
      failures.push(stopped.error.message);
    }
    if (failures.length > 0) {
      throw new FlakeProcessError({ message: failures.join("; ") });
    }
    // Yield for exit/reparenting without relying on a fixed wall-clock delay.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new FlakeProcessError({
    message: "Trial-owned processes remain after bounded Linux cleanup",
  });
};
