import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import type { SignatureFileFormatKind } from "@stll/api-contract/legal-file-formats";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  SIGNATURE_WORKER_EXIT,
  SIGNATURE_WORKER_MODE,
  type SignatureWorkerReply,
  signatureWorkerReplySchema,
} from "@/api/lib/files/signature-preview-protocol";
import type { ZipNameCodePage } from "@/api/lib/files/zip-name-code-page";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { runExtractionBinaryWorker } from "@/api/lib/search/extract-content";

const SIGNATURE_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const replySchema = v.pipe(
  v.string(),
  v.parseJson(),
  signatureWorkerReplySchema,
);

const unavailable = (message: string) =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message,
  });

/** A file named as a signature whose bytes hold none the reader recognizes. */
export const signatureUnreadable = () =>
  unavailable("The signature could not be read");

/**
 * `unreadable`: the bytes hold no signature the reader recognizes. A carried
 * document may be a ZIP archive, whose names tie in `zipNameCodePage`.
 */
const runSignatureWorker = async (
  { bytes }: ScannedFile,
  kind: SignatureFileFormatKind,
  fileName: string,
  zipNameCodePage: ZipNameCodePage,
): Promise<Result<Uint8Array | "unreadable", HandlerError<422 | 503>>> => {
  if (bytes.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return Result.err(
      unavailable("The signature file exceeds the preview size limit"),
    );
  }
  const result = await runExtractionBinaryWorker({
    zipNameCodePage,
    args: [
      SIGNATURE_WORKER_MODE.preview,
      String(LIMITS.extractedContentMaxChars),
      kind,
      sanitizeFilenamePreservingExtension(fileName),
    ],
    stdin: new Blob([bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    maxOutputBytes: SIGNATURE_PREVIEW_MAX_OUTPUT_BYTES,
  });
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  if (result.error.exitCode === SIGNATURE_WORKER_EXIT.unreadable) {
    return Result.ok("unreadable");
  }
  if (result.error.exitCode === SIGNATURE_WORKER_EXIT.rejected) {
    return Result.err(
      unavailable("The signed document did not pass the security scan"),
    );
  }
  return Result.err(
    new HandlerError({
      status: 503,
      code: "upstream_unavailable",
      message: "The signature reader is unavailable",
      cause: result.error,
    }),
  );
};

/** Null when the bytes hold no signature the reader recognizes. */
export const readSignatureWorkerReply = async (
  source: ScannedFile,
  kind: SignatureFileFormatKind,
  zipNameCodePage: ZipNameCodePage,
): Promise<
  Result<SignatureWorkerReply | null, HandlerError<422 | 500 | 503>>
> => {
  const result = await runSignatureWorker(
    source,
    kind,
    source.fileName,
    zipNameCodePage,
  );
  if (result.isErr()) {
    return Result.err(result.error);
  }
  const output = result.value;
  if (output === "unreadable") {
    return Result.ok(null);
  }
  const reply = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(output),
  );
  const parsed = Result.isError(reply)
    ? null
    : v.safeParse(replySchema, reply.value);
  return parsed?.success === true
    ? Result.ok(parsed.output)
    : Result.err(
        classifyFailure(
          new HandlerError({
            status: 500,
            message: "Invalid response from the signature reader",
          }),
          "response_invalid",
        ),
      );
};
