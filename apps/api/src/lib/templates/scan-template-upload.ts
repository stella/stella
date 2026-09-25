import { Result } from "better-result";

import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * An uploaded template DOCX, scanned before anything parses or stores it. A
 * rejecting verdict is the structured 422 every other upload route answers
 * with, a scanner failure a retryable 503; the bytes that come back are the
 * scanned copy, not the request's.
 */
export const scanTemplateUpload = async (
  file: File,
): Promise<Result<Buffer, HandlerError<422 | 503>>> =>
  Result.map(
    await scanUploadForHandler({
      bytes: await file.arrayBuffer(),
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: sanitizeFilename(file.name),
    }),
    (scanned) => Buffer.from(scanned.bytes),
  );

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
