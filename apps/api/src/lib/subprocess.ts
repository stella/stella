import { panic, Result } from "better-result";
import { existsSync } from "node:fs";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import {
  SUBPROCESS_TERMINATION_REASON,
  SubprocessError,
  type SubprocessTerminationReason,
} from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

/**
 * Writes a worker's answer to stdout and resolves once the pipe has taken all
 * of it. A worker exits right after answering, and `process.exit` drops what
 * is still queued on the pipe, so an unawaited large answer reaches the
 * parent cut short.
 */
export const writeWorkerStdout = async (
  output: string | Uint8Array,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

type SpawnWorkerOptions = {
  workerPath: string;
  args?: string[];
  stdin: Blob;
  timeoutMs: number;
  /** Aborting kills the subprocess instead of letting it run to timeout. */
  signal?: AbortSignal;
  /** Receives what a worker that exited successfully wrote to stderr. */
  onStderr?: (stderr: string) => void;
  /**
   * Resident memory the worker may reach. The parent reads it every
   * `LIMITS.workerRssPollMs` and kills the worker past it, or when the read
   * fails while the worker runs, which fails as a `memory` termination.
   * Without it the worker is bounded only by its timeout and its
   * container's limit.
   */
  maxRssBytes?: number | undefined;
};

type SpawnBinaryWorkerOptions = SpawnWorkerOptions & {
  maxOutputBytes: number;
};

const CRASH_SIGNAL_CODES = new Set([
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGILL",
  "SIGSEGV",
  "SIGTRAP",
]);

const readBoundedOutput = async (
  stream: ReadableStream<Uint8Array>,
  maxOutputBytes: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    if (chunk.byteLength > maxOutputBytes - totalBytes) {
      throw new SubprocessError({
        message: "Worker output exceeded the allowed size",
        exitCode: null,
        termination: null,
      });
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

export const classifySubprocessTermination = ({
  callerAbort,
  memoryAbort,
  signalCode,
  timeoutAbort,
}: {
  callerAbort: boolean;
  memoryAbort: boolean;
  signalCode: NonNullable<SpawnedWorker["signalCode"]>;
  timeoutAbort: boolean;
}): SubprocessTerminationReason => {
  if (memoryAbort) {
    return SUBPROCESS_TERMINATION_REASON.memory;
  }
  if (timeoutAbort) {
    return SUBPROCESS_TERMINATION_REASON.timeout;
  }
  if (callerAbort) {
    return SUBPROCESS_TERMINATION_REASON.cancelled;
  }
  if (CRASH_SIGNAL_CODES.has(String(signalCode))) {
    return SUBPROCESS_TERMINATION_REASON.crashed;
  }
  return SUBPROCESS_TERMINATION_REASON.external;
};

const exitFailure = ({
  callerAbort,
  exitCode,
  memoryAbort,
  signalCode,
  stderr,
  timeoutAbort,
}: {
  callerAbort: boolean;
  memoryAbort: boolean;
  exitCode: number;
  signalCode: SpawnedWorker["signalCode"];
  stderr: string;
  timeoutAbort: boolean;
}): SubprocessError => {
  if (signalCode !== null) {
    const reason = classifySubprocessTermination({
      callerAbort,
      memoryAbort,
      signalCode,
      timeoutAbort,
    });
    return new SubprocessError({
      message: `Worker ${reason} (${signalCode})`,
      exitCode: null,
      termination: { reason, signalCode: String(signalCode) },
    });
  }
  return new SubprocessError({
    message: `Worker failed (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
    exitCode,
    termination: null,
  });
};

type SpawnedWorker = ReturnType<typeof spawn>;

type SpawnWorkerProcessOptions = {
  args: string[];
  stdin: Blob;
  workerPath: string;
};

type WorkerTermination = {
  callerAbort: boolean;
  dispose: () => void;
  memoryAbort: boolean;
  timeoutAbort: boolean;
};

const HAS_PROC_FS = existsSync("/proc/self/status");
const VM_RSS = /^VmRSS:\s+(?<kilobytes>\d+) kB$/mu;
const BYTES_PER_KIB = 1024;

/** A zombie: exited, not yet reaped, and holding no memory. */
const ZOMBIE_STATE = /^State:\s+Z/mu;
const EXITED_ERROR_CODES = new Set(["ENOENT", "ESRCH"]);

/**
 * What reading another process's resident memory found: its size, that the
 * process has exited, or that the read failed while it may still be running.
 */
export type ProcessRss =
  | { type: "resident"; bytes: number }
  | { type: "exited" }
  | { type: "unreadable"; cause: unknown };

/** A resident size given in kibibytes, as both readers report it. */
const residentKilobytes = (token: string): ProcessRss => {
  const kilobytes = parseIntegerToken(token, { sign: "unsigned" });
  return Result.isOk(kilobytes)
    ? { type: "resident", bytes: kilobytes.value * BYTES_PER_KIB }
    : { type: "unreadable", cause: kilobytes.error };
};

const readProcStatusRss = async (pid: number): Promise<ProcessRss> => {
  const status = await Result.tryPromise(
    async () => await Bun.file(`/proc/${pid}/status`).text(),
  );
  if (Result.isError(status)) {
    const cause = status.error.cause;
    const code =
      cause instanceof Error && "code" in cause ? String(cause.code) : null;
    return code !== null && EXITED_ERROR_CODES.has(code)
      ? { type: "exited" }
      : { type: "unreadable", cause };
  }
  const kilobytes = VM_RSS.exec(status.value)?.groups?.["kilobytes"];
  if (kilobytes !== undefined) {
    return residentKilobytes(kilobytes);
  }
  return ZOMBIE_STATE.test(status.value)
    ? { type: "exited" }
    : { type: "unreadable", cause: "VmRSS is missing from a live process" };
};

const readPsRss = async (pid: number): Promise<ProcessRss> => {
  const answer = await Result.tryPromise(async () => {
    const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [kilobytes, exitCode] = await Promise.all([
      new Response(ps.stdout).text(),
      ps.exited,
    ]);
    return { exitCode, kilobytes: kilobytes.trim() };
  });
  if (Result.isError(answer)) {
    return { type: "unreadable", cause: answer.error };
  }
  const { exitCode, kilobytes } = answer.value;
  // ps lists nothing and exits 1 for a process that is gone.
  return exitCode === 1 && kilobytes === ""
    ? { type: "exited" }
    : residentKilobytes(kilobytes);
};

/**
 * Another process's resident memory. Linux, where every deployed process
 * runs, answers from `/proc/<pid>/status`; elsewhere (development on macOS)
 * `ps` does.
 */
export const readProcessRss = async (pid: number): Promise<ProcessRss> =>
  HAS_PROC_FS ? await readProcStatusRss(pid) : await readPsRss(pid);

/**
 * Reads a worker's resident memory every `LIMITS.workerRssPollMs` and calls
 * `onExceeded` once it is past `maxRssBytes`, or once it cannot be read
 * while the worker runs: a ceiling nobody can check is not held, so the
 * watch fails closed. A read still running when the next one is due is not
 * doubled up.
 */
const watchWorkerMemory = ({
  maxRssBytes,
  onExceeded,
  pid,
}: {
  maxRssBytes: number;
  onExceeded: () => void;
  pid: number;
}): (() => void) => {
  // The read in progress; it never rejects.
  let reading: Promise<void> | null = null;
  const check = async () => {
    const rss = await readProcessRss(pid);
    reading = null;
    switch (rss.type) {
      case "resident": {
        if (rss.bytes > maxRssBytes) {
          onExceeded();
        }
        return;
      }
      case "exited": {
        return;
      }
      case "unreadable": {
        onExceeded();
        return;
      }
      default: {
        rss satisfies never;
        panic("Unhandled process RSS reading");
      }
    }
  };
  const poll = () => {
    reading ??= check();
  };
  const timer = setInterval(poll, LIMITS.workerRssPollMs);
  return () => {
    clearInterval(timer);
  };
};

const watchWorkerTermination = ({
  maxRssBytes,
  signal,
  subprocess,
  timeoutSignal,
}: {
  maxRssBytes: number | undefined;
  signal: AbortSignal | undefined;
  subprocess: SpawnedWorker;
  timeoutSignal: AbortSignal;
}): (() => WorkerTermination) => {
  let callerAbort = false;
  let memoryAbort = false;
  let timeoutAbort = false;
  const killForCallerAbort = () => {
    callerAbort = true;
    subprocess.kill();
  };
  const killForTimeout = () => {
    timeoutAbort = true;
    subprocess.kill();
  };
  signal?.addEventListener("abort", killForCallerAbort, { once: true });
  timeoutSignal.addEventListener("abort", killForTimeout, { once: true });
  const stopMemoryWatch =
    maxRssBytes === undefined
      ? () => undefined
      : watchWorkerMemory({
          maxRssBytes,
          pid: subprocess.pid,
          // SIGKILL: a worker past its ceiling gets no time to grow further.
          onExceeded: () => {
            memoryAbort = true;
            subprocess.kill("SIGKILL");
          },
        });

  return () => ({
    callerAbort,
    memoryAbort,
    timeoutAbort,
    dispose: () => {
      stopMemoryWatch();
      signal?.removeEventListener("abort", killForCallerAbort);
      timeoutSignal.removeEventListener("abort", killForTimeout);
    },
  });
};

const spawn = ({ args, stdin, workerPath }: SpawnWorkerProcessOptions) =>
  Bun.spawn(["bun", "run", "--no-env-file", workerPath, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "" },
  });

export const spawnWorker = async ({
  workerPath,
  args = [],
  stdin,
  timeoutMs,
  signal,
  onStderr,
  maxRssBytes,
}: SpawnWorkerOptions): Promise<Result<string, SubprocessError>> => {
  signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const subprocess = spawn({ args, stdin, workerPath });
  const getTermination = watchWorkerTermination({
    maxRssBytes,
    signal,
    subprocess,
    timeoutSignal,
  });

  try {
    const [exit, stdout, stderr] = await Promise.all([
      subprocess.exited.then((exitCode) => ({
        exitCode,
        termination: getTermination(),
      })),
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    if (exit.exitCode !== 0) {
      return Result.err(
        exitFailure({
          exitCode: exit.exitCode,
          signalCode: subprocess.signalCode,
          stderr,
          ...exit.termination,
        }),
      );
    }

    if (stderr.length > 0) {
      onStderr?.(stderr);
    }
    return Result.ok(stdout);
  } catch (error) {
    subprocess.kill();
    return Result.err(
      new SubprocessError({
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        termination: null,
        cause: error,
      }),
    );
  } finally {
    getTermination().dispose();
  }
};

export const spawnBinaryWorker = async ({
  workerPath,
  args = [],
  stdin,
  timeoutMs,
  signal,
  maxOutputBytes,
  maxRssBytes,
}: SpawnBinaryWorkerOptions): Promise<Result<Uint8Array, SubprocessError>> => {
  signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const subprocess = spawn({ args, stdin, workerPath });
  const getTermination = watchWorkerTermination({
    maxRssBytes,
    signal,
    subprocess,
    timeoutSignal,
  });

  try {
    const [exit, stdout, stderr] = await Promise.all([
      subprocess.exited.then((exitCode) => ({
        exitCode,
        termination: getTermination(),
      })),
      readBoundedOutput(subprocess.stdout, maxOutputBytes),
      new Response(subprocess.stderr).text(),
    ]);
    if (exit.exitCode !== 0) {
      return Result.err(
        exitFailure({
          exitCode: exit.exitCode,
          signalCode: subprocess.signalCode,
          stderr,
          ...exit.termination,
        }),
      );
    }
    return Result.ok(stdout);
  } catch (error) {
    subprocess.kill();
    return Result.err(
      new SubprocessError({
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        termination: null,
        cause: error,
      }),
    );
  } finally {
    getTermination().dispose();
  }
};
