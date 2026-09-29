import type { Result } from "better-result";

import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * An uploaded template DOCX, scanned before anything parses or stores it. A
 * rejecting verdict is the structured 422 every other upload route answers
 * with, a scanner failure a retryable 503; the file that comes back holds the
 * scanned copy, not the request's bytes.
 */
export const scanTemplateUpload = async (
  file: File,
): Promise<Result<ScannedFile, HandlerError<422 | 503>>> =>
  await scanUploadForHandler({
    bytes: await file.arrayBuffer(),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: sanitizeFilename(file.name),
  });

/**
 * The same error as a JSON response, for the template routes that answer
 * with a raw `Response`. The body matches what the safe-handler boundary sends
 * for a `HandlerError`, so clients read one shape.
 */
export const templateUploadRejectionResponse = (
  error: HandlerError<422 | 503>,
): Response =>
  new Response(
    JSON.stringify({
      ...(error.code === undefined ? {} : { code: error.code }),
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.issues === undefined ? {} : { issues: error.issues }),
    }),
    { status: error.status, headers: { "Content-Type": "application/json" } },
  );
