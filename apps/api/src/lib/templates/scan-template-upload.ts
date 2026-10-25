import { Result } from "better-result";

import { validateDocxArchive } from "@/api/lib/docx-archive";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { failureSink } from "@/api/lib/observability/failure";
import { observedResponse } from "@/api/lib/observability/server-error-answer";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** A scanner that could not reach a verdict; a rejected file is not one. */
const TEMPLATE_UPLOAD_SCAN_FAILED = failureSink({
  event: "templates.upload_scan_failed",
  expected: [],
});

/**
 * An uploaded template DOCX, scanned before anything parses or stores it. A
 * rejecting verdict is the structured 422 every other upload route answers
 * with, a scanner failure a retryable 503; the file that comes back holds the
 * scanned copy, not the request's bytes.
 */
export const scanTemplateUpload = async (
  file: File,
): Promise<Result<ScannedFile, HandlerError<422 | 503>>> => {
  const bytes = await file.arrayBuffer();
  const validated = await validateDocxArchive(bytes);
  if (Result.isError(validated)) {
    return validated;
  }
  return await scanUploadForHandler({
    bytes,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: sanitizeFilename(file.name),
  });
};

/**
 * The same error as a JSON response, for the template routes that answer
 * with a raw `Response`. The body matches what the safe-handler boundary sends
 * for a `HandlerError`, so clients read one shape.
 */
export const templateUploadRejectionResponse = (
  error: HandlerError<422 | 503>,
): Response =>
  observedResponse(
    { sink: TEMPLATE_UPLOAD_SCAN_FAILED, cause: error },
    JSON.stringify({
      ...(error.code === undefined ? {} : { code: error.code }),
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.issues === undefined ? {} : { issues: error.issues }),
    }),
    { status: error.status, headers: { "Content-Type": "application/json" } },
  );
