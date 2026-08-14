import { Result } from "better-result";

import {
  SubprocessError,
  SUBPROCESS_TERMINATION_REASON,
  type SubprocessTerminationReason,
} from "@/api/lib/errors/tagged-errors";

type SpawnWorkerOptions = {
  workerPath: string;
  args?: string[];
  stdin: Blob;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Aborting kills the subprocess instead of letting it run to timeout. */
  signal?: AbortSignal;
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
  signalCode,
  timeoutAbort,
}: {
  callerAbort: boolean;
  signalCode: string;
  timeoutAbort: boolean;
}): SubprocessTerminationReason => {
  if (timeoutAbort) {
    return SUBPROCESS_TERMINATION_REASON.timeout;
  }
  if (callerAbort) {
    return SUBPROCESS_TERMINATION_REASON.cancelled;
  }
  if (CRASH_SIGNAL_CODES.has(signalCode)) {
    return SUBPROCESS_TERMINATION_REASON.crashed;
  }
  return SUBPROCESS_TERMINATION_REASON.external;
};

const exitFailure = ({
  callerAbort,
  exitCode,
  signalCode,
  stderr,
  timeoutAbort,
}: {
  callerAbort: boolean;
  exitCode: number;
  signalCode: string | null;
  stderr: string;
  timeoutAbort: boolean;
}): SubprocessError => {
  if (signalCode !== null) {
    const reason = classifySubprocessTermination({
      callerAbort,
      signalCode,
      timeoutAbort,
    });
    return new SubprocessError({
      message: `Worker ${reason} (${signalCode})`,
      exitCode: null,
      termination: { reason, signalCode },
    });
  }
  return new SubprocessError({
    message: `Worker failed (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
    exitCode,
    termination: null,
  });
};

type SpawnedWorker = {
  exited: Promise<number>;
  kill: () => void;
  signalCode: string | null;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
};

type SpawnWorkerProcessOptions = {
  args: string[];
  env: Record<string, string> | undefined;
  stdin: Blob;
  workerPath: string;
};

type WorkerTermination = {
  callerAbort: boolean;
  dispose: () => void;
  timeoutAbort: boolean;
};

const watchWorkerTermination = ({
  signal,
  subprocess,
  timeoutSignal,
}: {
  signal: AbortSignal | undefined;
  subprocess: SpawnedWorker;
  timeoutSignal: AbortSignal;
}): (() => WorkerTermination) => {
  let callerAbort = false;
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

  return () => ({
    callerAbort,
    timeoutAbort,
    dispose: () => {
      signal?.removeEventListener("abort", killForCallerAbort);
      timeoutSignal.removeEventListener("abort", killForTimeout);
    },
  });
};

const spawn = ({
  args,
  env,
  stdin,
  workerPath,
}: SpawnWorkerProcessOptions): SpawnedWorker =>
  Bun.spawn(["bun", "run", workerPath, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...env,
    },
  });

export const spawnWorker = async ({
  workerPath,
  args = [],
  stdin,
  timeoutMs,
  env,
  signal,
}: SpawnWorkerOptions): Promise<Result<string, SubprocessError>> => {
  signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const subprocess = spawn({ args, env, stdin, workerPath });
  const getTermination = watchWorkerTermination({
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
  env,
  signal,
  maxOutputBytes,
}: SpawnBinaryWorkerOptions): Promise<Result<Uint8Array, SubprocessError>> => {
  signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const subprocess = spawn({ args, env, stdin, workerPath });
  const getTermination = watchWorkerTermination({
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
