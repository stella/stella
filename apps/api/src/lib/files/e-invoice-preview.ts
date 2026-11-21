import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { eInvoicePreviewSchema } from "@stll/api-contract/e-invoice";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import {
  E_INVOICE_ATTACHMENT_HEADER_END,
  E_INVOICE_WORKER_EXIT,
  E_INVOICE_WORKER_MODE,
} from "@/api/lib/files/e-invoice-protocol";
import { LIMITS } from "@/api/lib/limits";
import {
  type SanitizedFileName,
  sanitizeFilenamePreservingExtension,
} from "@/api/lib/sanitize-filename";
import { EXTRACTION_WORKER_PATH } from "@/api/lib/search/extract-content";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

const E_INVOICE_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const E_INVOICE_ATTACHMENT_HEADER_MAX_BYTES = 4096;
const previewReplySchema = v.pipe(
  v.string(),
  v.parseJson(),
  eInvoicePreviewSchema,
);
const attachmentHeaderSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ fileName: v.string(), mimeType: v.string() }),
);

const unavailable = (message: string) =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message,
  });

const invalidReply = () =>
  classifyFailure(
    new HandlerError({
      status: 500,
      message: "Invalid response from the invoice reader",
    }),
    "response_invalid",
  );

const runEInvoiceWorker = async (
  { bytes }: ScannedFile,
  expectedMimeType: string,
  args: readonly string[],
): Promise<Result<Uint8Array, HandlerError<404 | 422 | 503>>> => {
  if (bytes.byteLength > DOCUMENT_ARCHIVE_MAX_BYTES) {
    return Result.err(
      unavailable("The invoice file exceeds the preview size limit"),
    );
  }
  const result = await spawnBinaryWorker({
    workerPath: EXTRACTION_WORKER_PATH,
    args: [
      args[0] ?? "",
      String(LIMITS.extractedContentMaxChars),
      expectedMimeType,
      ...args.slice(1),
    ],
    stdin: new Blob([bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    // A packaged attachment inflates up to the archive's decompression cap.
    maxOutputBytes:
      args[0] === E_INVOICE_WORKER_MODE.attachment
        ? DOCUMENT_ARCHIVE_MAX_BYTES + E_INVOICE_ATTACHMENT_HEADER_MAX_BYTES
        : E_INVOICE_PREVIEW_MAX_OUTPUT_BYTES,
  });
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  switch (result.error.exitCode) {
    case E_INVOICE_WORKER_EXIT.unreadable:
      return Result.err(unavailable("The invoice file could not be read"));
    case E_INVOICE_WORKER_EXIT.notInvoice:
      return Result.err(
        unavailable("The file is not a recognised structured invoice"),
      );
    case E_INVOICE_WORKER_EXIT.rejected:
      return Result.err(
        unavailable("An embedded file did not pass the security scan"),
      );
    case E_INVOICE_WORKER_EXIT.noAttachment:
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "The invoice has no such attachment",
        }),
      );
    default:
      return Result.err(
        new HandlerError({
          status: 503,
          code: "upstream_unavailable",
          message: "The invoice reader is unavailable",
          cause: result.error,
        }),
      );
  }
};

/** Reads a stored ISDOC, ISDOCX or XML file as a structured invoice. */
export const readEInvoicePreview = async (
  source: ScannedFile,
  expectedMimeType = source.mimeType,
): Promise<
  Result<
    v.InferOutput<typeof eInvoicePreviewSchema>,
    HandlerError<404 | 422 | 500 | 503>
  >
> => {
  const reply = await runEInvoiceWorker(source, expectedMimeType, [
    E_INVOICE_WORKER_MODE.preview,
  ]);
  if (reply.isErr()) {
    return Result.err(reply.error);
  }
  const parsed = v.safeParse(
    previewReplySchema,
    new TextDecoder().decode(reply.value),
  );
  return parsed.success ? Result.ok(parsed.output) : Result.err(invalidReply());
};

/**
 * One attachment of a stored invoice, scanned in the worker, with its type
 * detected from its bytes. A signed `.p7m` invoice is opened first.
 */
export const readEInvoiceAttachment =
  (index: number) =>
  async (
    source: ScannedFile,
  ): Promise<
    Result<
      { fileName: SanitizedFileName; mimeType: string; bytes: Uint8Array },
      HandlerError<404 | 422 | 500 | 503>
    >
  > => {
    const reply = await runEInvoiceWorker(source, source.mimeType, [
      E_INVOICE_WORKER_MODE.attachment,
      String(index),
    ]);
    if (reply.isErr()) {
      return Result.err(reply.error);
    }
    const end = reply.value.indexOf(E_INVOICE_ATTACHMENT_HEADER_END);
    const header =
      end === -1
        ? undefined
        : v.safeParse(
            attachmentHeaderSchema,
            new TextDecoder().decode(reply.value.subarray(0, end)),
          );
    if (!header?.success) {
      return Result.err(invalidReply());
    }
    return Result.ok({
      fileName: sanitizeFilenamePreservingExtension(header.output.fileName),
      mimeType: header.output.mimeType,
      bytes: reply.value.subarray(end + 1),
    });
  };
