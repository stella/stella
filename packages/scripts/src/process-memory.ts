import { panic, Result, TaggedError } from "better-result";
import { readFileSync } from "node:fs";

import {
  parseWindowsProcessRows,
  windowsProcessTreeCommand,
  WINDOWS_POWERSHELL_COMMAND,
  type WindowsProcessIdentity,
  type createWindowsProcessOwnership,
} from "./windows-process-ownership";

const GIB = 1024 ** 3;
const SAMPLE_INTERVAL_MS = 2000;
export const TEST_INVOCATION_MEMORY_GIB_ENV = "TEST_INVOCATION_MEMORY_GIB";

/** Each invocation owns a root-and-descendants budget; API lanes have separate budgets. */
export const testInvocationMemoryLimit = (environment: NodeJS.ProcessEnv) => {
  const value = environment[TEST_INVOCATION_MEMORY_GIB_ENV];
  const gib = value === undefined ? 6 : Number(value);
  const bytes = gib * GIB;
  if (!Number.isFinite(bytes) || gib <= 0) {
    panic(`${TEST_INVOCATION_MEMORY_GIB_ENV} must be a positive number`);
  }
  return bytes;
};

class ProcessMemoryReadError extends TaggedError("ProcessMemoryReadError")<{
  message: string;
  cause?: unknown;
}> {}

const processGone = ({ cause }: ProcessMemoryReadError) =>
  cause instanceof Error && "code" in cause && cause.code === "ESRCH";

type ProcessTreeSample = {
  identities: WindowsProcessIdentity[];
  readings: Map<number, Result<number, ProcessMemoryReadError>>;
  children: Map<number, number[]>;
  unavailable: ProcessMemoryReadError | undefined;
};

type ProcessMemoryReader = ((
  pid: number,
) => Result<number, ProcessMemoryReadError>) & {
  sampleTree?: (
    pid: number,
    signal: AbortSignal,
  ) => Promise<Result<ProcessTreeSample, ProcessMemoryReadError>>;
};

/** Ignore foreign rows even if a sampler returns more than the owned tree. */
export const parseWindowsProcessTree = (rootPid: number, output: string) => {
  const parsed = parseWindowsProcessRows(output);
  if (parsed.isErr()) {
    return Result.err(
      new ProcessMemoryReadError({
        message: parsed.error.message,
        cause: parsed.error,
      }),
    );
  }
  const rows = new Map(parsed.value.rows.map((row) => [row.pid, row] as const));
  const unavailable =
    parsed.value.unavailable === undefined
      ? undefined
      : new ProcessMemoryReadError({
          message: parsed.value.unavailable.message,
          cause: parsed.value.unavailable,
        });
  const sample: ProcessTreeSample = {
    identities: [],
    readings: new Map(),
    children: new Map(),
    unavailable,
  };
  const owned = [rootPid];
  for (const pid of owned) {
    const row = rows.get(pid);
    if (row?.creationTime !== undefined) {
      sample.identities.push({ pid, creationTime: row.creationTime });
    }
    sample.readings.set(
      pid,
      row !== undefined && Number.isFinite(row.bytes) && row.bytes >= 0
        ? Result.ok(row.bytes)
        : Result.err(
            new ProcessMemoryReadError({
              message: `Cannot read memory for PID ${pid}`,
            }),
          ),
    );
    const descendants: number[] = [];
    for (const [candidate, value] of rows) {
      if (value.parent === pid && !owned.includes(candidate)) {
        descendants.push(candidate);
        owned.push(candidate);
      }
    }
    sample.children.set(pid, descendants);
  }
  return Result.ok(sample);
};

const sampleWindowsProcessTree = async (rootPid: number, signal: AbortSignal) =>
  Result.tryPromise({
    try: async () => {
      // Windows has no POSIX process group: query the full descendant census on
      // every sample. Working sets are queried only for those owned PIDs.
      // Keep the root handle open through the census, so its identity survives
      // an exit during the query. CIM dates have microsecond precision; compare
      // that metadata to the handle before retaining its exact FILETIME.
      const command = windowsProcessTreeCommand({ rootPid });
      const child = Bun.spawn([...WINDOWS_POWERSHELL_COMMAND], {
        stdin: new TextEncoder().encode(command),
        stdout: "pipe",
        stderr: "ignore",
        signal,
        timeout: 5000,
        killSignal: "SIGKILL",
      });
      const [output, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      if (exitCode !== 0) {
        return Result.err(
          new ProcessMemoryReadError({
            message: `Cannot sample process tree rooted at PID ${rootPid}`,
          }),
        );
      }
      return parseWindowsProcessTree(rootPid, output);
    },
    catch: (cause) =>
      new ProcessMemoryReadError({
        message: `Cannot sample process tree rooted at PID ${rootPid}`,
        cause,
      }),
  }).then((result) => result.andThen((sample) => sample));

/** Read the child's memory, never the host's free-memory counters. */
const loadProcessMemoryReader = async () => {
  if (process.platform === "darwin") {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pid_rusage: {
        args: [FFIType.i32, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    // Darwin rusage_info_v2: UUID, seven uint64s, then physical footprint.
    // Footprint includes compressed pages; RSS alone can hide that memory.
    const buffer = new Uint8Array(160);
    const view = new DataView(buffer.buffer);
    return (pid: number) => {
      if (library.symbols.proc_pid_rusage(pid, 2, ptr(buffer)) !== 0) {
        return Result.err(
          new ProcessMemoryReadError({
            message: `Cannot read memory for PID ${pid}`,
          }),
        );
      }
      return Result.ok(
        Math.max(
          Number(view.getBigUint64(64, true)),
          Number(view.getBigUint64(72, true)),
        ),
      );
    };
  }
  if (process.platform === "linux") {
    return (pid: number) => {
      const loaded = Result.try({
        try: () => readFileSync(`/proc/${pid}/status`, "utf-8"),
        catch: (cause) =>
          new ProcessMemoryReadError({ message: String(cause), cause }),
      });
      if (loaded.isErr()) {
        return Result.err(loaded.error);
      }
      const status = loaded.value;
      const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.at(1);
      const swap = /^VmSwap:\s+(\d+)\s+kB$/mu.exec(status)?.at(1);
      if (rss === undefined || swap === undefined) {
        if (/^State:\s+Z\b/mu.test(status)) {
          return Result.ok(0);
        }
        return Result.err(
          new ProcessMemoryReadError({
            message: `Cannot read memory for PID ${pid}`,
          }),
        );
      }
      return Result.ok((Number(rss) + Number(swap)) * 1024);
    };
  }
  if (process.platform === "win32") {
    return Object.assign(
      (pid: number) =>
        Result.err(
          new ProcessMemoryReadError({
            message: `No completed memory sample for PID ${pid}`,
          }),
        ),
      { sampleTree: sampleWindowsProcessTree },
    );
  }
  return panic(`No test process memory reader for ${process.platform}`);
};

let memoryReader: ReturnType<typeof loadProcessMemoryReader> | undefined;
export const createProcessMemoryReader = async () =>
  (memoryReader ??= loadProcessMemoryReader());

const processChildren = (pid: number) => {
  const result = Bun.spawnSync(["pgrep", "-P", String(pid)], { timeout: 1000 });
  // pgrep uses status 1 to report an empty child set.
  if (!result.success && result.exitCode !== 1) {
    return Result.err(
      new ProcessMemoryReadError({
        message: `Cannot enumerate children of PID ${pid}`,
      }),
    );
  }
  const text = result.stdout.toString().trim();
  if (text === "") {
    return Result.ok([]);
  }
  const pids: number[] = [];
  for (const value of text.split(/\s+/u)) {
    const childPid = Number(value);
    if (!Number.isSafeInteger(childPid) || childPid <= 0) {
      return Result.err(
        new ProcessMemoryReadError({
          message: `Invalid child PID of ${pid}`,
        }),
      );
    }
    pids.push(childPid);
  }
  return Result.ok(pids);
};

type WatchTestProcessMemoryOptions = {
  child: Pick<
    Bun.Subprocess,
    "pid" | "exitCode" | "signalCode" | "kill" | "exited"
  >;
  limitBytes: number;
  readBytes: ProcessMemoryReader;
  file: () => string;
  onFailure: (message: string) => void;
  onWarning: (message: string) => void;
  termination?: "process" | "group";
  intervalMs?: number;
  children?: (pid: number) => Result<readonly number[], ProcessMemoryReadError>;
  signalPid?: (pid: number, signal: NodeJS.Signals | 0) => void;
  windowsProcesses?:
    | Pick<
        ReturnType<typeof createWindowsProcessOwnership>,
        "recordTree" | "signal" | "finish"
      >
    | undefined;
};

type KillMemoryProcessTreeOptions = Pick<
  WatchTestProcessMemoryOptions,
  "child" | "termination" | "onFailure" | "windowsProcesses"
> & {
  sampledPids: readonly number[];
  signalPid: NonNullable<WatchTestProcessMemoryOptions["signalPid"]>;
};

const killMemoryProcessTree = ({
  child,
  termination,
  sampledPids,
  signalPid,
  windowsProcesses,
  onFailure,
}: KillMemoryProcessTreeOptions) => {
  if (windowsProcesses !== undefined) {
    const killed = windowsProcesses.signal("SIGKILL");
    if (killed.isErr()) {
      onFailure(
        `Could not kill Windows test process tree ${child.pid}: ${killed.error.message}`,
      );
    }
    return;
  }
  if (termination === "group") {
    const killed = Result.try({
      try: () => signalPid(-child.pid, "SIGKILL"),
      catch: (cause) =>
        new ProcessMemoryReadError({ message: String(cause), cause }),
    });
    if (killed.isErr() && !processGone(killed.error)) {
      onFailure(
        `Could not kill test process group ${child.pid}: ${killed.error.message}`,
      );
    }
  }
  for (const pid of sampledPids.toReversed()) {
    if (pid === child.pid) {
      continue;
    }
    const killed = Result.try({
      try: () => signalPid(pid, "SIGKILL"),
      catch: (cause) =>
        new ProcessMemoryReadError({ message: String(cause), cause }),
    });
    if (killed.isErr() && !processGone(killed.error)) {
      onFailure(
        `Could not kill test descendant PID ${pid}: ${killed.error.message}`,
      );
    }
  }
  child.kill("SIGKILL");
};

type ObserveWindowsProcessExitOptions = Pick<
  WatchTestProcessMemoryOptions,
  "child"
> & {
  windowsProcesses: NonNullable<
    WatchTestProcessMemoryOptions["windowsProcesses"]
  >;
};

const observeWindowsProcessExit = ({
  child,
  windowsProcesses,
}: ObserveWindowsProcessExitOptions) => {
  let status: "watching" | "stopped" = "watching";
  let failure: ProcessMemoryReadError | undefined;
  const finish = () => {
    const finished = Result.try({
      try: () => windowsProcesses.finish(),
      catch: (cause) =>
        new ProcessMemoryReadError({
          message: `Cannot retain descendants at test process exit: ${String(cause)}`,
          cause,
        }),
    });
    if (finished.isErr()) {
      failure = finished.error;
    }
  };
  const exited = Result.tryPromise({
    try: async () => {
      await child.exited;
      if (status === "watching") {
        finish();
      }
    },
    catch: (cause) =>
      new ProcessMemoryReadError({ message: String(cause), cause }),
  });
  return {
    stop: async () => {
      finish();
      status = "stopped";
      if (child.exitCode !== null || child.signalCode !== null) {
        const settled = await exited;
        if (settled.isErr()) {
          failure ??= settled.error;
        }
      }
      return failure;
    },
  };
};

export const watchTestProcessMemory = ({
  child,
  limitBytes,
  readBytes,
  file,
  onFailure,
  onWarning,
  termination = "process",
  intervalMs = SAMPLE_INTERVAL_MS,
  children = processChildren,
  windowsProcesses,
  signalPid = (pid, signal) => {
    process.kill(pid, signal);
  },
}: WatchTestProcessMemoryOptions) => {
  let peakBytes = 0;
  let failure: string | undefined;
  let sampledPids: number[] = [];
  let stopped = false;
  let warned = false;
  const fail = (message: string) => {
    failure = message;
    killMemoryProcessTree({
      child,
      termination,
      sampledPids,
      signalPid,
      windowsProcesses,
      onFailure,
    });
    onFailure(message);
  };
  const sample = (tree?: ProcessTreeSample) => {
    if (
      stopped ||
      failure !== undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    sampledPids = [child.pid];
    let unavailable = tree?.unavailable;
    for (let index = 0; index < sampledPids.length; index += 1) {
      const pid = sampledPids.at(index) ?? panic("Missing sampled PID");
      const descendants = Result.try({
        try: () =>
          tree === undefined
            ? children(pid)
            : Result.ok(tree.children.get(pid) ?? []),
        catch: (cause) =>
          new ProcessMemoryReadError({ message: String(cause), cause }),
      }).andThen((result) => result);
      if (descendants.isErr()) {
        unavailable ??= descendants.error;
        continue;
      }
      for (const childPid of descendants.value) {
        if (!sampledPids.includes(childPid)) {
          sampledPids.push(childPid);
        }
      }
    }
    let totalBytes = 0;
    for (const pid of sampledPids) {
      const read = Result.try({
        try: () =>
          tree === undefined
            ? readBytes(pid)
            : (tree.readings.get(pid) ??
              Result.err(
                new ProcessMemoryReadError({
                  message: `Cannot read memory for PID ${pid}`,
                }),
              )),
        catch: (cause) =>
          new ProcessMemoryReadError({ message: String(cause), cause }),
      }).andThen((result) => result);
      if (read.isErr()) {
        const alive = Result.try({
          try: () => signalPid(pid, 0),
          catch: (cause) =>
            new ProcessMemoryReadError({ message: String(cause), cause }),
        });
        if (pid !== child.pid && alive.isErr() && processGone(alive.error)) {
          continue;
        }
        unavailable ??= read.error;
        continue;
      }
      const bytes = read.value;
      if (!Number.isFinite(bytes) || bytes < 0) {
        unavailable ??= new ProcessMemoryReadError({
          message: `Invalid memory reading for PID ${pid}`,
        });
        continue;
      }
      totalBytes += bytes;
    }
    // Missing readings contribute no invented bytes. The readable sum is still
    // a lower bound that can prove a breach; retry unknowns on the next sample.
    if (unavailable !== undefined && !warned) {
      warned = true;
      onWarning(
        `Test memory sample partially unavailable for ${file()}; enforcing readable lower bound and retrying: ${unavailable.message}`,
      );
    }
    peakBytes = Math.max(peakBytes, totalBytes);
    if (peakBytes > limitBytes) {
      fail(
        `Test invocation memory limit exceeded for ${file()} (process tree rooted at PID ${child.pid}): measured peak ${(peakBytes / GIB).toFixed(3)} GiB, cap ${(limitBytes / GIB).toFixed(3)} GiB`,
      );
    }
  };
  const exitObserver =
    windowsProcesses === undefined
      ? undefined
      : observeWindowsProcessExit({ child, windowsProcesses });
  const cancellation = new AbortController();
  let pendingSample: Promise<void> | undefined;
  const tick = () => {
    if (
      stopped ||
      failure !== undefined ||
      pendingSample !== undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    const sampleTree = readBytes.sampleTree;
    if (sampleTree === undefined) {
      sample();
      return;
    }
    // The watchdog owns one asynchronous query at a time; stop aborts it.
    pendingSample = sampleTree(child.pid, cancellation.signal)
      .then((result) => {
        if (result.isOk()) {
          // A completed census can still establish ownership after the root's
          // exit notification. Retain it before memory sampling stops.
          windowsProcesses?.recordTree(result.value.identities);
        }
        if (stopped) {
          return undefined;
        }
        sample(
          result.isOk()
            ? result.value
            : {
                identities: [],
                readings: new Map(),
                children: new Map(),
                unavailable: result.error,
              },
        );
        return undefined;
      })
      .finally(() => {
        pendingSample = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    stop: async () => {
      // The final synchronous census retains orphans before cancellation can
      // discard the asynchronous query that was still running at root exit.
      const exitStopped = exitObserver?.stop();
      stopped = true;
      clearInterval(timer);
      cancellation.abort();
      await pendingSample;
      const exitFailure = await exitStopped;
      if (exitFailure !== undefined) {
        onWarning(exitFailure.message);
      }
    },
    failure: () => failure,
    peakBytes: () => peakBytes,
  };
};
