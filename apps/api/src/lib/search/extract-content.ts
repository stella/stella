/**
 * Extract plain text from uploaded files (PDF, DOCX, spreadsheets,
 * presentations, and the other office formats listed in
 * `extractable-mime-types.ts`).
 *
 * Extraction runs in a separate Bun subprocess so parser crashes do
 * not directly crash the API process. A hard timeout kills the
 * subprocess if it hangs. This is process isolation, not an OS
 * security sandbox.
 */

import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import { ExtractionWorkerError } from "@/api/lib/errors/tagged-errors";
import { resolveEmailMimeType } from "@/api/lib/files/email-to-html";
import { LIMITS } from "@/api/lib/limits";
import { resolveRuntimeWorkerPath } from "@/api/lib/runtime-worker-path";
import {
  canExtractMimeType,
  normalizeMimeType,
} from "@/api/lib/search/extractable-mime-types";
import { spawnWorker } from "@/api/lib/subprocess";
import {
  DOC_MIME_TYPE,
  DOCM_MIME_TYPE,
  DOCX_MIME_TYPE,
  EPUB_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PDF_MIME_TYPE,
  PPSX_MIME_TYPE,
  PPT_MIME_TYPE,
  PPTX_MIME_TYPE,
  RTF_MIME_TYPE,
  XLS_MIME_TYPE,
  XLSB_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: "extraction-worker.js",
  sourceDir: import.meta.dir,
  sourceFile: "extraction-worker.ts",
});

/**
 * Recovers a usable MIME type for files stored under a generic type
 * (browsers routinely upload office documents as
 * `application/octet-stream`). Extension is only consulted after the
 * stored MIME type has been rejected.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  doc: DOC_MIME_TYPE,
  docm: DOCM_MIME_TYPE,
  docx: DOCX_MIME_TYPE,
  epub: EPUB_MIME_TYPE,
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  odp: ODP_MIME_TYPE,
  ods: ODS_MIME_TYPE,
  odt: ODT_MIME_TYPE,
  pdf: PDF_MIME_TYPE,
  ppsx: PPSX_MIME_TYPE,
  ppt: PPT_MIME_TYPE,
  pptx: PPTX_MIME_TYPE,
  rtf: RTF_MIME_TYPE,
  text: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  txt: "text/plain",
  xls: XLS_MIME_TYPE,
  xlsb: XLSB_MIME_TYPE,
  xlsx: XLSX_MIME_TYPE,
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
  return EXTENSION_MIME_TYPES[extension] ?? normalized;
};

export const extractFileTextResult = async (
  buffer: ArrayBuffer,
  mimeType: string,
) => {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!canExtractMimeType(normalizedMimeType)) {
    return Result.ok(null);
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
    return Result.err(error);
  }

  return Result.ok(result.value || null);
};

/**
 * Best-effort extraction for request paths where an empty fallback is valid.
 * Durable document processing uses `extractFileTextResult` so a worker crash
 * can never be mistaken for a successfully empty document.
 */
export const extractFileText = async (
  buffer: ArrayBuffer,
  mimeType: string,
  context?: Record<string, string>,
): Promise<string | null> => {
  const result = await extractFileTextResult(buffer, mimeType);
  if (Result.isError(result)) {
    captureError(result.error, {
      mimeType: normalizeMimeType(mimeType),
      sizeBytes: String(buffer.byteLength),
      exitCode: String(result.error.exitCode),
      ...context,
    });
    return null;
  }
  return result.value;
};
