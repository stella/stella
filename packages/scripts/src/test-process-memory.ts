import { panic, Result, TaggedError } from "better-result";
import { readFileSync } from "node:fs";

const GIB = 1024 ** 3;
const SAMPLE_INTERVAL_MS = 2000;
export const TEST_RUN_MEMORY_GIB_ENV = "TEST_RUN_MEMORY_GIB";

export const testRunMemoryLimit = (environment: NodeJS.ProcessEnv) => {
  const value = environment[TEST_RUN_MEMORY_GIB_ENV];
  const gib = value === undefined ? 6 : Number(value);
  const bytes = gib * GIB;
  if (!Number.isFinite(bytes) || gib <= 0) {
    panic(`${TEST_RUN_MEMORY_GIB_ENV} must be a positive number`);
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
        throw new ProcessMemoryReadError({
          message: `Cannot read memory for PID ${pid}`,
        });
      }
      return Math.max(
        Number(view.getBigUint64(64, true)),
        Number(view.getBigUint64(72, true)),
      );
    };
  }
  if (process.platform === "linux") {
    return (pid: number) => {
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.at(1);
      const swap = /^VmSwap:\s+(\d+)\s+kB$/mu.exec(status)?.at(1);
      if (rss === undefined || swap === undefined) {
        if (/^State:\s+Z\b/mu.test(status)) {
          return 0;
        }
        throw new ProcessMemoryReadError({
          message: `Cannot read memory for PID ${pid}`,
        });
      }
      return (Number(rss) + Number(swap)) * 1024;
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
        throw new ProcessMemoryReadError({
          message: `Cannot read memory for PID ${pid}`,
        });
      }
      return bytes;
    };
  }
  panic(`No test process memory reader for ${process.platform}`);
};

let memoryReader: ReturnType<typeof loadProcessMemoryReader> | undefined;
export const createProcessMemoryReader = async () =>
  (memoryReader ??= loadProcessMemoryReader());

const processChildren = (pid: number): number[] => {
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
    throw new ProcessMemoryReadError({
      message: `Cannot enumerate children of PID ${pid}`,
    });
  }
  const text = result.stdout.toString().trim();
  if (text === "") {
    return [];
  }
  return text.split(/\s+/u).map((value) => {
    const childPid = Number(value);
    if (!Number.isSafeInteger(childPid) || childPid <= 0) {
      throw new ProcessMemoryReadError({
        message: `Invalid child PID of ${pid}`,
      });
    }
    return childPid;
  });
};

type WatchTestProcessMemoryOptions = {
  child: Pick<Bun.Subprocess, "pid" | "exitCode" | "signalCode" | "kill">;
  limitBytes: number;
  readBytes: (pid: number) => number;
  file: () => string;
  onFailure: (message: string) => void;
  onWarning: (message: string) => void;
  termination?: "process" | "group";
  intervalMs?: number;
  children?: (pid: number) => readonly number[];
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
  signalPid = process.kill,
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
    const reading = Result.try({
      try: () => {
        sampledPids = [child.pid];
        for (let index = 0; index < sampledPids.length; index += 1) {
          const pid = sampledPids.at(index) ?? panic("Missing sampled PID");
          for (const childPid of children(pid)) {
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
          });
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
            throw read.error;
          }
          const bytes = read.value;
          if (!Number.isFinite(bytes) || bytes < 0) {
            throw new ProcessMemoryReadError({
              message: `Invalid memory reading for PID ${pid}`,
            });
          }
          totalBytes += bytes;
        }
        return totalBytes;
      },
      catch: (cause) =>
        new ProcessMemoryReadError({ message: String(cause), cause }),
    });
    if (reading.isErr()) {
      // An unreadable sample is unknown, not evidence of exceeding the cap.
      // Retry on the next tick; bound diagnostics to one warning per run.
      if (!warned && child.exitCode === null && child.signalCode === null) {
        warned = true;
        onWarning(
          `Test memory sample unavailable for ${file()}; retrying: ${reading.error.message}`,
        );
      }
      return;
    }
    peakBytes = Math.max(peakBytes, reading.value);
    if (peakBytes > limitBytes) {
      fail(
        `Test run memory limit exceeded for ${file()} (process tree rooted at PID ${child.pid}): peak ${(peakBytes / GIB).toFixed(3)} GiB, cap ${(limitBytes / GIB).toFixed(3)} GiB`,
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
