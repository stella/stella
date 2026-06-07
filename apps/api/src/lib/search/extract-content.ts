/**
 * Extract plain text from uploaded files (PDF, DOCX).
 *
 * Extraction runs in an isolated Bun subprocess so that parser
 * crashes or exploits (buffer overflow, prototype pollution,
 * infinite loops) cannot affect the main API process. A hard
 * timeout kills the subprocess if it hangs.
 */

import { Result } from "better-result";

import {
  EMAIL_MIME_TYPES,
  resolveEmailMimeType,
} from "@/api/handlers/files/email-to-html";
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

const DIRECT_TEXT_MIME_TYPES = new Set<string>([
  "application/json",
  "text/calendar",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
]);

const TEXT_EXTENSION_MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  text: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  txt: "text/plain",
};

const BINARY_EXTRACTION_MIME_TYPES = new Set<string>([
  PDF_MIME_TYPE,
  DOCX_MIME_TYPE,
]);

export const normalizeMimeType = (mimeType: string): string =>
  mimeType.split(";").at(0)?.trim().toLowerCase() ?? "";

export const isDirectTextMimeType = (mimeType: string): boolean =>
  DIRECT_TEXT_MIME_TYPES.has(normalizeMimeType(mimeType));

export const canExtractMimeType = (mimeType: string): boolean => {
  const normalized = normalizeMimeType(mimeType);
  return (
    BINARY_EXTRACTION_MIME_TYPES.has(normalized) ||
    isDirectTextMimeType(normalized) ||
    normalized in EMAIL_MIME_TYPES
  );
};

export const resolveExtractionMimeType = ({
  fileName,
  mimeType,
}: {
  fileName: string;
  mimeType: string;
}): string => {
  const normalized = normalizeMimeType(mimeType);
  if (canExtractMimeType(normalized)) {
    return normalized;
  }

  const emailMimeType = resolveEmailMimeType({ fileName, mimeType });
  if (emailMimeType) {
    return emailMimeType;
  }

  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return normalized;
  }
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return TEXT_EXTENSION_MIME_TYPES[extension] ?? normalized;
};

export const extractFileText = async (
  buffer: ArrayBuffer,
  mimeType: string,
  context?: Record<string, string>,
) => {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!canExtractMimeType(normalizedMimeType)) {
    return null;
  }

  const result = await spawnWorker({
    workerPath: WORKER_PATH,
    args: [normalizedMimeType],
    stdin: new Blob([buffer]),
    timeoutMs: LIMITS.extractionTimeoutMs,
  });

  if (Result.isError(result)) {
    const error = new ExtractionWorkerError({
      message: result.error.message,
      exitCode: result.error.exitCode,
    });
    captureError(error, {
      mimeType: normalizedMimeType,
      sizeBytes: String(buffer.byteLength),
      exitCode: String(result.error.exitCode),
      ...context,
    });
    return null;
  }

  return result.value || null;
};
