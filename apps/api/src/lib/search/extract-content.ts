/**
 * Extract plain text from uploaded files (PDF, DOCX).
 *
 * Extraction runs in an isolated Bun subprocess so that parser
 * crashes or exploits (buffer overflow, prototype pollution,
 * infinite loops) cannot affect the main API process. A hard
 * timeout kills the subprocess if it hangs.
 */

import { resolve } from "node:path";
import { Result, TaggedError } from "better-result";

import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { LIMITS } from "@/api/lib/limits";
import { captureError } from "@/api/lib/posthog";

class ExtractionWorkerError extends TaggedError("ExtractionWorkerError")<{
  message: string;
  exitCode: number | null;
}>() {}

const WORKER_PATH = resolve(import.meta.dir, "extraction-worker.ts");

const SUPPORTED_MIMES: string[] = [PDF_MIME_TYPE, DOCX_MIME_TYPE];

const spawnExtraction = async (
  buffer: ArrayBuffer,
  mimeType: string,
): Promise<Result<string | null, ExtractionWorkerError>> => {
  const subprocess = Bun.spawn(["bun", "run", WORKER_PATH, mimeType], {
    stdin: new Blob([buffer]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
    },
    timeout: LIMITS.extractionTimeoutMs,
  });

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    if (exitCode !== 0) {
      return Result.err(
        new ExtractionWorkerError({
          message: stderr.slice(0, 500),
          exitCode,
        }),
      );
    }

    return Result.ok(stdout || null);
  } catch (err) {
    subprocess.kill();
    return Result.err(
      new ExtractionWorkerError({
        message: err instanceof Error ? err.message : String(err),
        exitCode: null,
      }),
    );
  }
};

export const extractFileText = async (
  buffer: ArrayBuffer,
  mimeType: string,
) => {
  if (!SUPPORTED_MIMES.includes(mimeType)) {
    return null;
  }

  const result = await spawnExtraction(buffer, mimeType);

  if (Result.isError(result)) {
    captureError(result.error);
    return null;
  }

  return result.value;
};
