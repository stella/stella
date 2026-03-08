import { resolve } from "node:path";
import { Result, TaggedError } from "better-result";

import { LIMITS } from "@/api/lib/limits";
import { spawnWorker } from "@/api/lib/subprocess";

export class CorruptedPdfError extends TaggedError("CorruptedPdfError")<{
  message: string;
}>() {}

const WORKER_PATH = resolve(import.meta.dir, "pdf-worker.ts");

export const isEncryptedPdf = async (buffer: ArrayBuffer) => {
  const result = await spawnWorker({
    workerPath: WORKER_PATH,
    stdin: new Blob([buffer]),
    timeoutMs: LIMITS.extractionTimeoutMs,
  });

  if (Result.isError(result)) {
    return Result.err(
      new CorruptedPdfError({
        message: result.error.message,
      }),
    );
  }

  return Result.ok(result.value === "true");
};
