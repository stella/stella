import { panic, Result, TaggedError } from "better-result";
import { readFileSync } from "node:fs";

import type { WindowsProcessOwnership } from "./windows-process-ownership";

const GIB = 1024 ** 3;
const SAMPLE_INTERVAL_MS = 2000;
export const TEST_INVOCATION_MEMORY_GIB_ENV = "TEST_INVOCATION_MEMORY_GIB";

/** Each invocation owns a root-and-descendants budget; API lanes have separate budgets. */
export const testInvocationMemoryLimit = (environment: NodeJS.ProcessEnv) => {
  const value = environment[TEST_INVOCATION_MEMORY_GIB_ENV];
  const gib = value === undefined ? 6 : Number(value);
  const bytes = Math.floor(gib * GIB);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || gib <= 0) {
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

export const parseLinuxProcessMemoryStatus = (pid: number, status: string) => {
  const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.at(1);
  const swap = /^VmSwap:\s+(\d+)\s+kB$/mu.exec(status)?.at(1);
  if (rss === undefined || swap === undefined) {
    // proc_pid_status emits Vm* only while get_task_mm returns an address
    // space. During exit it can be absent before the PID/state becomes dead.
    // Partial memory fields remain an error; an entire absent block means zero.
    if (
      /^State:\s+[RSDTtXZxPI]\b/mu.test(status) &&
      !/^Vm[A-Za-z]+:/mu.test(status)
    ) {
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

type ProcessMemoryReader = (
  pid: number,
) => Result<number, ProcessMemoryReadError>;

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
      return parseLinuxProcessMemoryStatus(pid, loaded.value);
    };
  }
  if (process.platform === "win32") {
    return (pid: number) =>
      Result.err(
        new ProcessMemoryReadError({
          message: `Windows test PID ${pid} requires a Job Object memory owner`,
        }),
      );
  }
  return panic(`No test process memory reader for ${process.platform}`);
};

let memoryReader: ReturnType<typeof loadProcessMemoryReader> | undefined;
export const createProcessMemoryReader = async () =>
  (memoryReader ??= loadProcessMemoryReader());

/** Process-group membership survives launcher exit and reparenting. A child
 * that calls setsid escapes this boundary; Linux cgroup containment is out of
 * scope for these portable test runners. */
export const parseProcessGroupMemory = (pgid: number, output: string) => {
  const readings = new Map<number, number>();
  for (const line of output.trim().split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }
    const columns = line.trim().split(/\s+/u).map(Number);
    const [pid, group, rss] = columns;
    if (
      columns.length !== 3 ||
      pid === undefined ||
      group === undefined ||
      rss === undefined ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(group) ||
      group < 0 ||
      !Number.isSafeInteger(rss) ||
      rss < 0 ||
      !Number.isSafeInteger(rss * 1024)
    ) {
      return Result.err(
        new ProcessMemoryReadError({
          message: "Invalid process-group memory sample",
        }),
      );
    }
    if (group === pgid) {
      readings.set(pid, rss * 1024);
    }
  }
  return Result.ok(readings);
};

const sampleProcessGroupMemory = (pgid: number) =>
  Result.try({
    try: () => {
      const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,rss="], {
        timeout: 1000,
      });
      if (!result.success) {
        return Result.err(
          new ProcessMemoryReadError({
            message: `Cannot sample process group ${pgid}`,
            cause: result.stderr.toString(),
          }),
        );
      }
      return parseProcessGroupMemory(pgid, result.stdout.toString());
    },
    catch: (cause) =>
      new ProcessMemoryReadError({ message: String(cause), cause }),
  }).andThen((result) => result);

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
  intervalMs?: number;
  sampleGroup?: typeof sampleProcessGroupMemory;
  signalPid?: (pid: number, signal: NodeJS.Signals | 0) => void;
  windowsProcesses?:
    Pick<WindowsProcessOwnership, "readMemory" | "signal"> | undefined;
};

type KillMemoryProcessTreeOptions = Pick<
  WatchTestProcessMemoryOptions,
  "child" | "onFailure" | "windowsProcesses"
> & {
  signalPid: NonNullable<WatchTestProcessMemoryOptions["signalPid"]>;
};

const killMemoryProcessTree = ({
  child,
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
};

export const watchTestProcessMemory = ({
  child,
  limitBytes,
  readBytes,
  file,
  onFailure,
  onWarning,
  intervalMs = SAMPLE_INTERVAL_MS,
  sampleGroup = sampleProcessGroupMemory,
  windowsProcesses,
  signalPid = (pid, signal) => {
    process.kill(pid, signal);
  },
}: WatchTestProcessMemoryOptions) => {
  let peakBytes = 0;
  let failure: string | undefined;
  let stopped = false;
  let warned = false;
  const fail = (message: string) => {
    failure = message;
    killMemoryProcessTree({
      child,
      signalPid,
      windowsProcesses,
      onFailure,
    });
    onFailure(message);
  };
  const sample = () => {
    if (stopped || failure !== undefined) {
      return;
    }
    const group = Result.try({
      try: () =>
        windowsProcesses !== undefined
          ? Result.ok(new Map([[child.pid, 0]]))
          : sampleGroup(child.pid),
      catch: (cause) =>
        new ProcessMemoryReadError({ message: String(cause), cause }),
    }).andThen((result) => result);
    let unavailable = group.isErr() ? group.error : undefined;
    // If ps fails, retain a readable root lower bound without inventing workers.
    const readings = group.isOk() ? group.value : new Map([[child.pid, 0]]);
    // An empty group releases ownership permanently; never adopt a later group
    // that happens to reuse this numeric PGID.
    if (group.isOk() && readings.size === 0) {
      stopped = true;
      return;
    }
    const jobMemory =
      windowsProcesses === undefined
        ? undefined
        : Result.try({
            try: () => windowsProcesses.readMemory(),
            catch: (cause) =>
              new ProcessMemoryReadError({ message: String(cause), cause }),
          }).andThen((result) => result);
    const memoryStatus = jobMemory?.isOk()
      ? jobMemory.value.status
      : "within-limit";
    let totalBytes = 0;
    for (const [pid, rssBytes] of readings) {
      const read = Result.try({
        try: () => {
          if (jobMemory === undefined) {
            return readBytes(pid);
          }
          return jobMemory.isErr()
            ? Result.err(jobMemory.error)
            : Result.ok(jobMemory.value.peakBytes);
        },
        catch: (cause) =>
          new ProcessMemoryReadError({ message: String(cause), cause }),
      }).andThen((result) => result);
      if (read.isErr()) {
        const alive = Result.try({
          try: () => signalPid(pid, 0),
          catch: (cause) =>
            new ProcessMemoryReadError({ message: String(cause), cause }),
        });
        // A census can outlive either the leader or a worker. Keep its readable
        // RSS lower bound without diagnosing normal process exit as a read fault.
        // Job accounting remains readable after leader exit, so its errors differ.
        if (
          jobMemory === undefined &&
          ((pid === child.pid &&
            (child.exitCode !== null || child.signalCode !== null)) ||
            (alive.isErr() && processGone(alive.error)))
        ) {
          totalBytes += rssBytes;
          continue;
        }
        unavailable ??= new ProcessMemoryReadError({
          message: read.error.message,
          cause: read.error,
        });
        totalBytes += rssBytes;
        continue;
      }
      const bytes = read.value;
      if (!Number.isFinite(bytes) || bytes < 0) {
        unavailable ??= new ProcessMemoryReadError({
          message: `Invalid memory reading for PID ${pid}`,
        });
        totalBytes += rssBytes;
        continue;
      }
      totalBytes += Math.max(bytes, rssBytes);
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
    if (peakBytes > limitBytes || memoryStatus === "limit-exceeded") {
      fail(
        `Test invocation memory limit exceeded for ${file()} (process tree rooted at PID ${child.pid}): measured ${windowsProcesses === undefined ? "" : "job committed-memory "}peak ${(peakBytes / GIB).toFixed(3)} GiB, cap ${(limitBytes / GIB).toFixed(3)} GiB${memoryStatus === "limit-exceeded" ? "; Windows job rejected an allocation over its hard cap" : ""}`,
      );
    }
  };
  const tick = sample;
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    stop: async () => {
      sample();
      stopped = true;
      clearInterval(timer);
      await Promise.resolve();
    },
    failure: () => failure,
    peakBytes: () => peakBytes,
  };
};
