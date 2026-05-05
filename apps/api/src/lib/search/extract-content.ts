/**
 * Extract plain text from uploaded files (PDF, DOCX).
 *
 * Extraction runs in an isolated Bun subprocess so that parser
 * crashes or exploits (buffer overflow, prototype pollution,
 * infinite loops) cannot affect the main API process. A hard
 * timeout kills the subprocess if it hangs.
 */

import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics";
import { ExtractionWorkerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { resolveRuntimeWorkerPath } from "@/api/lib/runtime-worker-path";
import { spawnWorker } from "@/api/lib/subprocess";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: "extraction-worker.js",
  sourceDir: import.meta.dir,
  sourceFile: "extraction-worker.ts",
});

const SUPPORTED_MIMES = new Set<string>([PDF_MIME_TYPE, DOCX_MIME_TYPE]);

export const extractFileText = async (
  buffer: ArrayBuffer,
  mimeType: string,
  context?: Record<string, string>,
) => {
  if (!SUPPORTED_MIMES.has(mimeType)) {
    return null;
  }

  const result = await spawnWorker({
    workerPath: WORKER_PATH,
    args: [mimeType],
    stdin: new Blob([buffer]),
    timeoutMs: LIMITS.extractionTimeoutMs,
  });

  if (Result.isError(result)) {
    const error = new ExtractionWorkerError({
      message: result.error.message,
      exitCode: result.error.exitCode,
    });
    captureError(error, {
      mimeType,
      sizeBytes: String(buffer.byteLength),
      exitCode: String(result.error.exitCode),
      ...context,
    });
    return null;
  }

  return result.value || null;
};
