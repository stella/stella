import { panic, Result, TaggedError } from "better-result";
import { readFileSync } from "node:fs";

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
    return (pid: number) => {
      const result = Bun.spawnSync(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
        ],
        { timeout: 1000 },
      );
      const bytes = Number(result.stdout.toString().trim());
      if (!result.success || !Number.isFinite(bytes) || bytes <= 0) {
        return Result.err(
          new ProcessMemoryReadError({
            message: `Cannot read memory for PID ${pid}`,
          }),
        );
      }
      return Result.ok(bytes);
    };
  }
  return panic(`No test process memory reader for ${process.platform}`);
};

let memoryReader: ReturnType<typeof loadProcessMemoryReader> | undefined;
export const createProcessMemoryReader = async () =>
  (memoryReader ??= loadProcessMemoryReader());

const processChildren = (pid: number) => {
  const result =
    process.platform === "win32"
      ? Bun.spawnSync(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object -ExpandProperty ProcessId`,
          ],
          { timeout: 1000 },
        )
      : Bun.spawnSync(["pgrep", "-P", String(pid)], { timeout: 1000 });
  // pgrep uses status 1 to report an empty child set.
  if (
    !result.success &&
    !(process.platform !== "win32" && result.exitCode === 1)
  ) {
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
  child: Pick<Bun.Subprocess, "pid" | "exitCode" | "signalCode" | "kill">;
  limitBytes: number;
  readBytes: (pid: number) => Result<number, ProcessMemoryReadError>;
  file: () => string;
  onFailure: (message: string) => void;
  onWarning: (message: string) => void;
  termination?: "process" | "group";
  intervalMs?: number;
  children?: (pid: number) => Result<readonly number[], ProcessMemoryReadError>;
  signalPid?: (pid: number, signal: NodeJS.Signals | 0) => void;
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
    if (termination === "group") {
      const killed = Result.try({
        try: () => signalPid(-child.pid, "SIGKILL"),
        catch: (cause) =>
          new ProcessMemoryReadError({ message: String(cause), cause }),
      });
      if (
        killed.isErr() &&
        !(
          killed.error.cause instanceof Error &&
          "code" in killed.error.cause &&
          killed.error.cause.code === "ESRCH"
        )
      ) {
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
      if (
        killed.isErr() &&
        !(
          killed.error.cause instanceof Error &&
          "code" in killed.error.cause &&
          killed.error.cause.code === "ESRCH"
        )
      ) {
        onFailure(
          `Could not kill test descendant PID ${pid}: ${killed.error.message}`,
        );
      }
    }
    child.kill("SIGKILL");
    onFailure(message);
  };
  const sample = () => {
    if (
      stopped ||
      failure !== undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    sampledPids = [child.pid];
    let unavailable: ProcessMemoryReadError | undefined;
    for (let index = 0; index < sampledPids.length; index += 1) {
      const pid = sampledPids.at(index) ?? panic("Missing sampled PID");
      const descendants = Result.try({
        try: () => children(pid),
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
        try: () => readBytes(pid),
        catch: (cause) =>
          new ProcessMemoryReadError({ message: String(cause), cause }),
      }).andThen((result) => result);
      if (read.isErr()) {
        const alive = Result.try({
          try: () => signalPid(pid, 0),
          catch: (cause) =>
            new ProcessMemoryReadError({ message: String(cause), cause }),
        });
        if (
          pid !== child.pid &&
          alive.isErr() &&
          alive.error.cause instanceof Error &&
          "code" in alive.error.cause &&
          alive.error.cause.code === "ESRCH"
        ) {
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
  const timer = setInterval(sample, intervalMs);
  sample();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    failure: () => failure,
    peakBytes: () => peakBytes,
  };
};
