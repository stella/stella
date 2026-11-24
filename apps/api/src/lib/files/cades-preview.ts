import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { cadesPreviewSchema } from "@stll/api-contract/cades";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  CADES_WORKER_EXIT,
  CADES_WORKER_MODE,
} from "@/api/lib/files/cades-preview-protocol";
import type { ZipNameCodePage } from "@/api/lib/files/zip-name-code-page";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { runExtractionBinaryWorker } from "@/api/lib/search/extract-content";

const CADES_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const previewReplySchema = v.pipe(
  v.string(),
  v.parseJson(),
  cadesPreviewSchema,
);

const unavailable = (message: string) =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message,
  });

const runCadesWorker = async (
  { bytes }: ScannedFile,
  fileName: string,
  zipNameCodePage: ZipNameCodePage,
): Promise<Result<Uint8Array, HandlerError<422 | 503>>> => {
  if (bytes.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return Result.err(
      unavailable("The CAdES file exceeds the preview size limit"),
    );
  }

  const result = await runExtractionBinaryWorker({
    zipNameCodePage,
    args: [
      CADES_WORKER_MODE.preview,
      String(LIMITS.extractedContentMaxChars),
      sanitizeFilenamePreservingExtension(fileName),
    ],
    stdin: new Blob([bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    maxOutputBytes: CADES_PREVIEW_MAX_OUTPUT_BYTES,
  });
  if (result.isOk()) {
    return Result.ok(result.value);
  }

  if (result.error.exitCode === CADES_WORKER_EXIT.unreadable) {
    return Result.err(unavailable("The CAdES file could not be read"));
  }
  if (result.error.exitCode === CADES_WORKER_EXIT.rejected) {
    return Result.err(
      unavailable("The embedded file did not pass the security scan"),
    );
  }
  return Result.err(
    new HandlerError({
      status: 503,
      code: "upstream_unavailable",
      message: "The CAdES reader is unavailable",
      cause: result.error,
    }),
  );
};

/**
 * A signed envelope's preview. Its document is read in turn and may be a ZIP
 * archive, whose names tie in `zipNameCodePage`.
 */
export const readCadesPreview = async (
  source: ScannedFile,
  {
    zipNameCodePage,
    fileName = source.fileName,
  }: { zipNameCodePage: ZipNameCodePage; fileName?: string },
): Promise<
  Result<
    v.InferOutput<typeof cadesPreviewSchema>,
    HandlerError<422 | 500 | 503>
  >
> => {
  const result = await runCadesWorker(source, fileName, zipNameCodePage);
  if (result.isErr()) {
    return Result.err(result.error);
  }

  const parsed = v.safeParse(
    previewReplySchema,
    new TextDecoder().decode(result.value),
  );
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        classifyFailure(
          new HandlerError({
            status: 500,
            message: "Invalid response from the CAdES reader",
          }),
          "response_invalid",
        ),
      );
};
