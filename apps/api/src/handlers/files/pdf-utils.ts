import { resolve } from "node:path";
import { Result, TaggedError } from "better-result";

import { LIMITS } from "@/api/lib/limits";

export class CorruptedPdfError extends TaggedError("CorruptedPdfError")<{
  message: string;
}>() {}

const WORKER_PATH = resolve(import.meta.dir, "pdf-worker.ts");

export const isEncryptedPdf = async (buffer: ArrayBuffer) => {
  const subprocess = Bun.spawn(["bun", "run", WORKER_PATH], {
    stdin: new Blob([buffer]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
    },
    timeout: LIMITS.extractionTimeoutMs,
  });

  try {
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    if (exitCode !== 0) {
      return Result.err(
        new CorruptedPdfError({
          message: `PDF validation failed (exit ${exitCode})`,
        }),
      );
    }

    return Result.ok(stdout === "true");
  } catch (err) {
    subprocess.kill();
    return Result.err(
      new CorruptedPdfError({
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
};
