import { Result } from "better-result";

import type { SubprocessError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { LIMITS } from "@/api/lib/limits";
import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";
import { spawnWorker } from "@/api/lib/subprocess";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: RUNTIME_WORKER_FILES.pdf,
  sourceDir: import.meta.dir,
  sourceFile: "pdf-worker.ts",
});

/**
 * What the PDF worker found out about a file's encryption.
 *
 * - `inspected`: the worker parsed the file and reported its encryption flag.
 * - `unreadable`: the worker ran and its parser refused the bytes (it exits
 *   with `PDF_WORKER_PARSE_ERROR_EXIT_CODE`), so the file is not a PDF the
 *   parser can open.
 * - `unsure`: the inspection did not finish (the timeout killed the worker,
 *   the worker died to a signal, it could not be started, or it exited with
 *   any other code, as Bun does when the worker or an import fails to load)
 *   or answered with something other than its two outputs. That says nothing
 *   about the file.
 */
export type PdfEncryptionProbe =
  | { status: "inspected"; encrypted: boolean }
  | { status: "unreadable"; cause: SubprocessError }
  | { status: "unsure"; cause: SubprocessError | string };

/** The worker's exit code for a parse error (EX_DATAERR); see pdf-worker.ts. */
export const PDF_WORKER_PARSE_ERROR_EXIT_CODE = 65;

/** A worker failure as a probe outcome: only the parse-error exit is a verdict. */
export const classifyPdfWorkerFailure = (
  error: SubprocessError,
): Extract<PdfEncryptionProbe, { status: "unreadable" | "unsure" }> =>
  error.exitCode === PDF_WORKER_PARSE_ERROR_EXIT_CODE
    ? { status: "unreadable", cause: error }
    : { status: "unsure", cause: error };

type PdfEncryptionProbeOptions = {
  /** Defaults to the extraction timeout; tests shorten it. */
  timeoutMs?: number | undefined;
};

/** Read through `detectFileEncryption`, which owns what a writer records. */
export const isEncryptedPdf = async (
  { bytes: buffer }: ScannedFile,
  { timeoutMs = LIMITS.extractionTimeoutMs }: PdfEncryptionProbeOptions = {},
): Promise<PdfEncryptionProbe> => {
  const result = await spawnWorker({
    workerPath: WORKER_PATH,
    stdin: new Blob([buffer]),
    timeoutMs,
  });

  if (Result.isError(result)) {
    return classifyPdfWorkerFailure(result.error);
  }

  if (result.value === "true" || result.value === "false") {
    return { status: "inspected", encrypted: result.value === "true" };
  }
  return {
    status: "unsure",
    cause: `PDF worker answered ${JSON.stringify(result.value.slice(0, 64))}`,
  };
};
