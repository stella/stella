import { Result } from "better-result";

import { SubprocessError } from "@/api/lib/errors/tagged-errors";

type SpawnWorkerOptions = {
  workerPath: string;
  args?: string[];
  stdin: Blob;
  timeoutMs: number;
  env?: Record<string, string>;
};

export const spawnWorker = async ({
  workerPath,
  args = [],
  stdin,
  timeoutMs,
  env: extraEnv,
}: SpawnWorkerOptions): Promise<Result<string, SubprocessError>> => {
  const subprocess = Bun.spawn(["bun", "run", workerPath, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      ...extraEnv,
    },
    timeout: timeoutMs,
  });

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
  }
};
