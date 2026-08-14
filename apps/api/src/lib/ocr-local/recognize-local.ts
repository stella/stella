/**
 * Local OCR provider: reads the source PDF from object storage, runs
 * `ocr-local-worker.ts` in an isolated subprocess, and revalidates its
 * JSON output before assembling the shared result shape. The worker
 * process lives for exactly one document, so renderer and inference
 * memory is reclaimed by process exit.
 */

import { Result } from "better-result";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { DocumentOcrPage } from "@/api/lib/document-processing-contract";
import {
  assembleDocumentOcrResult,
  DocumentOcrProviderError,
  OCR_TIMEOUT_MS,
  parseOcrPage,
  validateOcrResult,
  type DocumentOcrResult,
} from "@/api/lib/document-processing-ocr-result";
import { LIMITS } from "@/api/lib/limits";
import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";
import { getS3ObjectWithSignal } from "@/api/lib/s3";
import { spawnWorker } from "@/api/lib/subprocess";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: RUNTIME_WORKER_FILES.ocrLocal,
  sourceDir: import.meta.dir,
  sourceFile: "ocr-local-worker.ts",
});

const parseWorkerOutput = (raw: string): DocumentOcrPage[] => {
  const invalid = () =>
    new DocumentOcrProviderError({
      code: "invalid_response",
      message: "OCR worker returned an invalid result",
    });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!isRecord(value) || !isUnknownArray(value["pages"])) {
    throw invalid();
  }
  const pages: DocumentOcrPage[] = [];
  for (const pageValue of value["pages"]) {
    const page = parseOcrPage(pageValue);
    if (page === null) {
      throw invalid();
    }
    pages.push(page);
  }
  return pages;
};

export const recognizePdfTextLocally = async ({
  signal,
  sourceKey,
}: {
  idempotencyKey: string;
  signal: AbortSignal;
  sourceKey: string;
  sourceUrl: string;
}): Promise<Result<DocumentOcrResult, DocumentOcrProviderError>> =>
  await Result.tryPromise({
    try: async () => {
      const modelDir = envDocumentProcessingWorker.DOCUMENT_OCR_MODEL_DIR;
      if (!modelDir) {
        throw new DocumentOcrProviderError({
          code: "not_configured",
          message:
            "DOCUMENT_OCR_MODEL_DIR is required by the local OCR provider",
        });
      }

      const source = await getS3ObjectWithSignal(sourceKey, signal);
      if (source.byteLength > LIMITS.documentOcrSourceMaxBytes) {
        throw new DocumentOcrProviderError({
          code: "response_too_large",
          message: "OCR source document exceeded the allowed size",
        });
      }
      signal.throwIfAborted();
      const output = await spawnWorker({
        workerPath: WORKER_PATH,
        args: [modelDir],
        stdin: new Blob([source]),
        timeoutMs: OCR_TIMEOUT_MS,
      });
      if (Result.isError(output)) {
        throw new DocumentOcrProviderError({
          code: "request_failed",
          message: "OCR worker failed",
          cause: output.error,
        });
      }
      signal.throwIfAborted();

      return validateOcrResult(
        assembleDocumentOcrResult(parseWorkerOutput(output.value)),
      );
    },
    catch: (cause) =>
      cause instanceof DocumentOcrProviderError
        ? cause
        : new DocumentOcrProviderError({
            code: "request_failed",
            message: "Local OCR failed",
            cause,
          }),
  });
