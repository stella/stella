/**
 * Local OCR: reads the source PDF from object storage, runs
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
  DocumentOcrError,
  OCR_TIMEOUT_MS,
  parseOcrPage,
  validateOcrPageObservationResult,
  validateOcrResult,
  type DocumentOcrResult,
} from "@/api/lib/document-processing-ocr-result";
import { LIMITS } from "@/api/lib/limits";
import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";
import { getS3ObjectSizeWithSignal, getS3ObjectWithSignal } from "@/api/lib/s3";
import { spawnWorker } from "@/api/lib/subprocess";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: RUNTIME_WORKER_FILES.ocrLocal,
  sourceDir: import.meta.dir,
  sourceFile: "ocr-local-worker.ts",
});

const parseWorkerOutput = (raw: string): DocumentOcrPage[] => {
  const invalid = () =>
    new DocumentOcrError({
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

type LocalOcrOptions = {
  signal: AbortSignal;
  sourceKey: string;
  readSource?: (key: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  readSourceSize?: (key: string, signal: AbortSignal) => Promise<number | null>;
  resolveModelDir?: () => string | undefined;
};

const runLocalOcr = async (
  {
    readSource = getS3ObjectWithSignal,
    readSourceSize = getS3ObjectSizeWithSignal,
    resolveModelDir = () => envDocumentProcessingWorker.DOCUMENT_OCR_MODEL_DIR,
    signal,
    sourceKey,
  }: LocalOcrOptions,
  validate: (result: DocumentOcrResult) => DocumentOcrResult,
): Promise<Result<DocumentOcrResult, DocumentOcrError>> =>
  await Result.tryPromise({
    try: async () => {
      const modelDir = resolveModelDir();
      if (!modelDir) {
        throw new DocumentOcrError({
          code: "not_configured",
          message: "DOCUMENT_OCR_MODEL_DIR is required by the OCR worker",
        });
      }

      // Refuse an oversized source before materializing it; the post-read
      // check backstops storage backends that do not report a length.
      const declaredSize = await readSourceSize(sourceKey, signal);
      if (
        declaredSize !== null &&
        declaredSize > LIMITS.documentOcrSourceMaxBytes
      ) {
        throw new DocumentOcrError({
          code: "response_too_large",
          message: "OCR source document exceeded the allowed size",
        });
      }
      const source = await readSource(sourceKey, signal);
      if (source.byteLength > LIMITS.documentOcrSourceMaxBytes) {
        throw new DocumentOcrError({
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
        signal,
      });
      if (Result.isError(output)) {
        throw new DocumentOcrError({
          code: "request_failed",
          message: "OCR worker failed",
          cause: output.error,
        });
      }
      signal.throwIfAborted();

      return validate(
        assembleDocumentOcrResult(parseWorkerOutput(output.value)),
      );
    },
    catch: (cause) =>
      cause instanceof DocumentOcrError
        ? cause
        : new DocumentOcrError({
            code: "request_failed",
            message: "Local OCR failed",
            cause,
          }),
  });

export const recognizePdfTextLocally = async (
  options: LocalOcrOptions,
): Promise<Result<DocumentOcrResult, DocumentOcrError>> =>
  await runLocalOcr(options, validateOcrResult);

export const observePdfPagesLocally = async (
  options: LocalOcrOptions,
): Promise<Result<DocumentOcrResult, DocumentOcrError>> =>
  await runLocalOcr(options, validateOcrPageObservationResult);

export const isLocalDocumentOcrConfigured = (): boolean =>
  envDocumentProcessingWorker.DOCUMENT_OCR_MODEL_DIR !== undefined;
