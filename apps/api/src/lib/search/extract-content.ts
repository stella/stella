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

import { panic, Result } from "better-result";

import { legalFileFormat } from "@stll/api-contract/document-format";
import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";
import type { PST_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";
import { MBOX_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";
import { OFFICE_ARCHIVE_FORMATS } from "@stll/docx-utils/office-formats";

import { captureError } from "@/api/lib/analytics/capture";
import {
  EXTRACTION_WORKER_ERROR_CODE,
  ExtractionWorkerError,
  extractionWorkerErrorCode,
  SUBPROCESS_TERMINATION_REASON,
  type SubprocessError,
} from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  DOCUMENT_ARCHIVE_MAX_BYTES,
  isDocumentArchiveMimeType,
  MAILBOX_TEXT_WORKER_MODE,
  PST_WORKER_MODE,
  pstWorkerArguments,
} from "@/api/lib/files/archive-preview-protocol";
import {
  ZIP_NAME_CODE_PAGE_ENV,
  type ZipNameCodePage,
} from "@/api/lib/files/zip-name-code-page";
import { LIMITS } from "@/api/lib/limits";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { logger } from "@/api/lib/observability/logger";
import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";
import {
  canExtractMimeType,
  isOfficeDocumentMimeType,
  normalizeMimeType,
} from "@/api/lib/search/extractable-mime-types";
import {
  ATTACHMENT_EXTRACTION_OUTCOME,
  parseAttachmentIssues,
  STANDALONE_ATTACHMENT_MODE,
} from "@/api/lib/search/extraction-worker-attachments";
import { parseWorkerErrorClass } from "@/api/lib/search/extraction-worker-error";
import { spawnBinaryWorker, spawnWorker } from "@/api/lib/subprocess";
import {
  DOC_MIME_TYPE,
  EPUB_MIME_TYPE,
  PDF_MIME_TYPE,
  PPT_MIME_TYPE,
  RTF_MIME_TYPE,
  XLS_MIME_TYPE,
} from "@/api/mime-types";

const EXTRACTION_WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: RUNTIME_WORKER_FILES.extraction,
  sourceDir: import.meta.dir,
  sourceFile: "extraction-worker.ts",
});

type ExtractionWorkerRun = {
  /**
   * The code page a tie between readings of a ZIP archive's undeclared file
   * names goes to, from the organization whose file the run reads
   * (`readZipNameCodePage`). Null only for a mode that opens no ZIP archive
   * at any depth; such a run keeps the specification's.
   */
  zipNameCodePage: ZipNameCodePage | null;
};

const extractionWorkerEnv = ({ zipNameCodePage }: ExtractionWorkerRun) =>
  zipNameCodePage === null ? {} : { [ZIP_NAME_CODE_PAGE_ENV]: zipNameCodePage };

/**
 * Runs the extraction worker in one of its modes. Every run goes through
 * here or `runExtractionBinaryWorker`, so none starts without the code page
 * its archives' names are read in.
 */
const runExtractionWorker = async ({
  zipNameCodePage,
  ...options
}: Omit<Parameters<typeof spawnWorker>[0], "env" | "workerPath"> &
  ExtractionWorkerRun) =>
  await spawnWorker({
    ...options,
    workerPath: EXTRACTION_WORKER_PATH,
    env: extractionWorkerEnv({ zipNameCodePage }),
  });

/** `runExtractionWorker` for a mode that answers in bytes. */
export const runExtractionBinaryWorker = async ({
  zipNameCodePage,
  ...options
}: Omit<Parameters<typeof spawnBinaryWorker>[0], "env" | "workerPath"> &
  ExtractionWorkerRun) =>
  await spawnBinaryWorker({
    ...options,
    workerPath: EXTRACTION_WORKER_PATH,
    env: extractionWorkerEnv({ zipNameCodePage }),
  });

/**
 * Recovers a usable MIME type for files stored under a generic type
 * (browsers routinely upload office documents as
 * `application/octet-stream`). Extension is only consulted after the
 * stored MIME type has been rejected.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(OFFICE_ARCHIVE_FORMATS)
      .filter(([, format]) => canExtractMimeType(format.mimeType))
      .map(([extension, format]) => [extension, format.mimeType]),
  ),
  csv: "text/csv",
  doc: DOC_MIME_TYPE,
  epub: EPUB_MIME_TYPE,
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  pdf: PDF_MIME_TYPE,
  ppt: PPT_MIME_TYPE,
  rtf: RTF_MIME_TYPE,
  text: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  txt: "text/plain",
  xls: XLS_MIME_TYPE,
};

export const resolveExtractionMimeType = ({
  fileName,
  mimeType,
}: {
  fileName: string;
  mimeType: string;
}): string => {
  const legal = legalFileFormat(mimeType, fileName);
  if (legal) {
    return legal.mimeType;
  }
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

/**
 * Record the email attachments the worker could not read. The email itself
 * still extracts; these lines are how its missing attachment text stays
 * visible. An attachment in a form the parsers do not read is expected and
 * logged at info; a parser failing on one it should read is a warning.
 */
const reportAttachmentIssues = (stderr: string, mimeType: string): void => {
  for (const issue of parseAttachmentIssues(stderr)) {
    const attributes = {
      mimeType,
      "attachment.mimeType": issue.mimeType,
      "attachment.errorType": issue.errorType,
      "attachment.errorCode": issue.errorCode ?? "",
    };
    if (issue.outcome === ATTACHMENT_EXTRACTION_OUTCOME.skipped) {
      logger.info("search.extraction.attachment_skipped", attributes);
    } else {
      logger.warn("search.extraction.attachment_failed", attributes);
    }
  }
};

type ExtractFileTextResultOptions = {
  /**
   * Characters of text the worker keeps; the rest is cut. A caller that must
   * refuse an over-long text instead of storing it cut short asks for one
   * character past its own limit and refuses when it gets that many.
   */
  maxChars?: number;
  /** Standalone chat uploads have no separately filed attachment documents. */
  includeContainerAttachments?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The reading organization's (`readZipNameCodePage`). */
  zipNameCodePage: ZipNameCodePage;
};

const extractionMimeTypeOf = ({ mimeType, fileName }: ScannedFile) =>
  legalFileFormat(mimeType, fileName)?.mimeType ?? normalizeMimeType(mimeType);

export const extractFileTextResult = async (
  file: ScannedFile,
  options: ExtractFileTextResultOptions,
): Promise<Result<string | null, ExtractionWorkerError>> =>
  await extractTextInWorker(file, options);

/**
 * An Office document's text, which the worker reads with the Office reader:
 * it opens no ZIP archive's names, so it needs no organization's code page.
 * Any other type is a caller's defect, never read without one.
 */
export const extractOfficeDocumentTextResult = async (
  file: ScannedFile,
  options: Omit<ExtractFileTextResultOptions, "zipNameCodePage">,
): Promise<Result<string | null, ExtractionWorkerError>> =>
  isOfficeDocumentMimeType(extractionMimeTypeOf(file))
    ? await extractTextInWorker(file, { ...options, zipNameCodePage: null })
    : panic("Only an Office document is read without a ZIP name code page");

const extractTextInWorker = async (
  file: ScannedFile,
  {
    maxChars = LIMITS.extractedContentMaxChars,
    includeContainerAttachments = false,
    signal,
    timeoutMs = LIMITS.extractionTimeoutMs,
    zipNameCodePage,
  }: Omit<ExtractFileTextResultOptions, "zipNameCodePage"> &
    ExtractionWorkerRun,
): Promise<Result<string | null, ExtractionWorkerError>> => {
  const { bytes: buffer } = file;
  const normalizedMimeType = extractionMimeTypeOf(file);
  if (!canExtractMimeType(normalizedMimeType)) {
    return Result.ok(null);
  }

  if (
    isDocumentArchiveMimeType(normalizedMimeType) &&
    buffer.byteLength > DOCUMENT_ARCHIVE_MAX_BYTES
  ) {
    return Result.err(
      new ExtractionWorkerError({
        code: EXTRACTION_WORKER_ERROR_CODE.parser,
        message: "The document exceeds the archive reading limit",
        exitCode: null,
        mimeType: normalizedMimeType,
        sizeBytes: buffer.byteLength,
        termination: null,
        workerErrorClass: null,
      }),
    );
  }

  const result = await runExtractionWorker({
    zipNameCodePage,
    args: [
      normalizedMimeType,
      String(maxChars),
      ...(includeContainerAttachments ? [STANDALONE_ATTACHMENT_MODE] : []),
    ],
    ...(signal ? { signal } : {}),
    stdin: new Blob([buffer]),
    timeoutMs,
    onStderr: (stderr) => {
      reportAttachmentIssues(stderr, normalizedMimeType);
    },
  });

  if (Result.isError(result)) {
    return Result.err(
      extractionWorkerError(result.error, {
        mimeType: normalizedMimeType,
        sizeBytes: buffer.byteLength,
      }),
    );
  }

  return Result.ok(result.value || null);
};

const extractionWorkerError = (
  error: SubprocessError,
  { mimeType, sizeBytes }: { mimeType: string; sizeBytes: number },
) => {
  const termination =
    error.termination === null
      ? null
      : {
          reason: error.termination.reason,
          signalCode: error.termination.signalCode,
        };
  return new ExtractionWorkerError({
    code: extractionWorkerErrorCode(termination),
    message: error.message,
    exitCode: error.exitCode,
    mimeType,
    sizeBytes,
    termination,
    workerErrorClass: parseWorkerErrorClass(error.message),
  });
};

/** A mailbox format whose stored files are streamed into the worker. */
export type StreamedMailboxFormat =
  typeof MBOX_FILE_FORMAT | typeof PST_FILE_FORMAT;

/**
 * A stored mailbox's text, streamed from the store into the worker: a
 * `.mbox` is read one message at a time as it streams in, a `.pst` is
 * written to a temporary file the worker reads at an offset. The mailbox is
 * never held whole in memory on either side, whatever its size.
 */
export const extractMailboxStreamText = async ({
  stream,
  sizeBytes,
  fileName,
  format = MBOX_FILE_FORMAT,
  maxChars = LIMITS.extractedContentMaxChars,
  signal,
  timeoutMs = LIMITS.extractionTimeoutMs,
}: {
  stream: ReadableStream<Uint8Array>;
  sizeBytes: number;
  fileName: string;
  format?: StreamedMailboxFormat;
  maxChars?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Result<string | null, ExtractionWorkerError>> => {
  const result = await runExtractionWorker({
    // A mailbox's text is its messages' own text; no attachment is opened.
    zipNameCodePage: null,
    args:
      format.kind === "pst"
        ? [
            PST_WORKER_MODE.text,
            String(maxChars),
            ...pstWorkerArguments({ mailboxName: fileName, timeoutMs }),
          ]
        : [MAILBOX_TEXT_WORKER_MODE, String(maxChars), fileName],
    ...(signal ? { signal } : {}),
    stdin: stream,
    timeoutMs,
  });
  return Result.isError(result)
    ? Result.err(
        extractionWorkerError(result.error, {
          mimeType: format.mimeType,
          sizeBytes,
        }),
      )
    : Result.ok(result.value || null);
};

/**
 * Best-effort extraction for request paths where an empty fallback is valid.
 * Durable document processing uses `extractFileTextResult` so a worker crash
 * can never be mistaken for a successfully empty document.
 */
export const extractFileText = async (
  file: ScannedFile,
  context: Record<string, string> | undefined,
  options: Pick<ExtractFileTextResultOptions, "maxChars" | "zipNameCodePage">,
): Promise<string | null> => {
  const first = await extractFileTextResult(file, options);
  if (!Result.isError(first)) {
    return first.value;
  }

  // An externally killed worker (deploy restart, OOM reaper) says
  // nothing about the document, so this path gets one more attempt
  // before giving up; there is no queue behind it to requeue into.
  const retryable =
    first.error.termination?.reason === SUBPROCESS_TERMINATION_REASON.external;
  const result = retryable ? await extractFileTextResult(file, options) : first;
  if (!Result.isError(result)) {
    return result.value;
  }

  captureError(
    result.error,
    handlerErrorContext("search.extractFileText.result_error", context),
  );
  return null;
};
