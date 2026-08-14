import { Result } from "better-result";

import { SubprocessError } from "@/api/lib/errors/tagged-errors";

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

export const spawnWorker = async ({
  workerPath,
  args = [],
  stdin,
  timeoutMs,
  env: extraEnv,
  signal,
}: SpawnWorkerOptions): Promise<Result<string, SubprocessError>> => {
  signal?.throwIfAborted();
  const subprocess = Bun.spawn(["bun", "run", workerPath, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...extraEnv,
    },
    timeout: timeoutMs,
  });
  const killOnAbort = () => subprocess.kill();
  signal?.addEventListener("abort", killOnAbort, { once: true });

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    if (exitCode !== 0) {
      return Result.err(
        new SubprocessError({
          message: `Worker failed (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
          exitCode,
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
        cause: error,
      }),
    );
  } finally {
    // The lifecycle signal outlives this call; an accumulated listener per
    // spawn would leak across a long-running worker's many runs.
    signal?.removeEventListener("abort", killOnAbort);
  }
};

export const spawnBinaryWorker = async ({
  workerPath,
  args = [],
  stdin,
  timeoutMs,
  env: extraEnv,
  maxOutputBytes,
}: SpawnBinaryWorkerOptions): Promise<Result<Uint8Array, SubprocessError>> => {
  const subprocess = Bun.spawn(["bun", "run", workerPath, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...extraEnv,
    },
    timeout: timeoutMs,
  });

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      readBoundedOutput(subprocess.stdout, maxOutputBytes),
      new Response(subprocess.stderr).text(),
    ]);
    if (exitCode !== 0) {
      return Result.err(
        new SubprocessError({
          message: `Worker failed (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
          exitCode,
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
        cause: error,
      }),
    );
  }
};
