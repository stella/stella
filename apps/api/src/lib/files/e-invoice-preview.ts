import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { xmlDocumentPreviewSchema } from "@stll/api-contract/e-invoice";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import {
  E_INVOICE_WORKER_EXIT,
  E_INVOICE_WORKER_MODE,
} from "@/api/lib/files/e-invoice-protocol";
import { LIMITS } from "@/api/lib/limits";
import { runExtractionBinaryWorker } from "@/api/lib/search/extract-content";

const E_INVOICE_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const previewReplySchema = v.pipe(
  v.string(),
  v.parseJson(),
  xmlDocumentPreviewSchema,
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
): Promise<Result<Uint8Array, HandlerError<422 | 503>>> => {
  if (bytes.byteLength > DOCUMENT_ARCHIVE_MAX_BYTES) {
    return Result.err(
      unavailable("The invoice file exceeds the preview size limit"),
    );
  }
  const result = await runExtractionBinaryWorker({
    // An invoice's attachments are listed, never opened as archives.
    zipNameCodePage: null,
    args: [
      E_INVOICE_WORKER_MODE.preview,
      String(LIMITS.extractedContentMaxChars),
      expectedMimeType,
    ],
    stdin: new Blob([bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    maxOutputBytes: E_INVOICE_PREVIEW_MAX_OUTPUT_BYTES,
  });
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  const unavailableReader = () =>
    Result.err(
      new HandlerError({
        status: 503,
        code: "upstream_unavailable",
        message: "The invoice reader is unavailable",
        cause: result.error,
      }),
    );
  const { exitCode } = result.error;
  if (exitCode === null) {
    return unavailableReader();
  }
  switch (exitCode) {
    case E_INVOICE_WORKER_EXIT.unreadable:
      return Result.err(unavailable("The invoice file could not be read"));
    case E_INVOICE_WORKER_EXIT.rejected:
      return Result.err(
        unavailable("An embedded file did not pass the security scan"),
      );
    default:
      return unavailableReader();
  }
};

/** Reads a stored ISDOC, ISDOCX or XML file: its invoice, or an XML file's text. */
export const readEInvoicePreview = async (
  source: ScannedFile,
  expectedMimeType = source.mimeType,
): Promise<
  Result<
    v.InferOutput<typeof xmlDocumentPreviewSchema>,
    HandlerError<422 | 500 | 503>
  >
> => {
  const reply = await runEInvoiceWorker(source, expectedMimeType);
  if (reply.isErr()) {
    return Result.err(reply.error);
  }
  const parsed = v.safeParse(
    previewReplySchema,
    new TextDecoder().decode(reply.value),
  );
  return parsed.success ? Result.ok(parsed.output) : Result.err(invalidReply());
};
