import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { asicPreviewSchema } from "@stll/api-contract/asic";
import { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import { structuredDocumentPreviewSchema } from "@stll/api-contract/structured-document";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  ARCHIVE_PREVIEW_WORKER_EXIT,
  ASIC_PREVIEW_WORKER_MODE,
  DOCUMENT_ARCHIVE_MAX_BYTES,
  SIGNED_DOSSIER_WORKER_MODE,
  STRUCTURED_DOCUMENT_PREVIEW_MODE,
} from "@/api/lib/files/archive-preview-protocol";
import { LIMITS } from "@/api/lib/limits";
import { EXTRACTION_WORKER_PATH } from "@/api/lib/search/extract-content";
import { spawnBinaryWorker } from "@/api/lib/subprocess";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const ARCHIVE_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const unavailable = (message: string) =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message,
  });

function archivePreviewReader<Schema extends v.GenericSchema>({
  schema,
  mode,
  label,
}: {
  schema: Schema;
  mode: string;
  label: string;
}) {
  const replySchema = v.pipe(v.string(), v.parseJson(), schema);
  return async (
    source: ScannedFile,
    expectedMimeType = source.mimeType,
  ): Promise<Result<v.InferOutput<Schema>, HandlerError<422 | 500 | 503>>> => {
    const { bytes } = source;
    if (bytes.byteLength > DOCUMENT_ARCHIVE_MAX_BYTES) {
      return Result.err(
        unavailable(`The ${label} file exceeds the preview size limit`),
      );
    }

    const result = await spawnBinaryWorker({
      workerPath: EXTRACTION_WORKER_PATH,
      args: [mode, String(LIMITS.extractedContentMaxChars), expectedMimeType],
      stdin: new Blob([bytes]),
      timeoutMs: LIMITS.extractionTimeoutMs,
      maxOutputBytes: ARCHIVE_PREVIEW_MAX_OUTPUT_BYTES,
    });
    if (result.isErr()) {
      const { exitCode } = result.error;
      if (exitCode === ARCHIVE_PREVIEW_WORKER_EXIT.unreadable) {
        return Result.err(unavailable(`The ${label} file could not be read`));
      }
      if (exitCode === ARCHIVE_PREVIEW_WORKER_EXIT.rejected) {
        return Result.err(
          unavailable("An embedded file did not pass the security scan"),
        );
      }
      return Result.err(
        new HandlerError({
          status: 503,
          code: "upstream_unavailable",
          message: `The ${label} reader is unavailable`,
          cause: result.error,
        }),
      );
    }

    const parsed = v.safeParse(
      replySchema,
      new TextDecoder().decode(result.value),
    );
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err(
          classifyFailure(
            new HandlerError({
              status: 500,
              message: `Invalid response from the ${label} reader`,
            }),
            "response_invalid",
          ),
        );
  };
}
export const readAsicPreview = archivePreviewReader({
  mode: ASIC_PREVIEW_WORKER_MODE,
  schema: asicPreviewSchema,
  label: "ASiC",
});
export const readStructuredDocumentPreview = archivePreviewReader({
  mode: STRUCTURED_DOCUMENT_PREVIEW_MODE,
  schema: structuredDocumentPreviewSchema,
  label: "document",
});
export const readSignedDossierPreview = archivePreviewReader({
  mode: SIGNED_DOSSIER_WORKER_MODE.preview,
  schema: signedDossierPreviewSchema,
  label: "signed container",
});

/** One PDF document of a signed container, scanned like an upload. */
export const readSignedDossierPdf = async (
  source: ScannedFile,
  document: number,
): Promise<Result<Uint8Array, HandlerError<422 | 500 | 503>>> => {
  const { bytes } = source;
  if (bytes.byteLength > DOCUMENT_ARCHIVE_MAX_BYTES) {
    return Result.err(
      unavailable("The signed container exceeds the preview size limit"),
    );
  }
  const result = await spawnBinaryWorker({
    workerPath: EXTRACTION_WORKER_PATH,
    args: [
      SIGNED_DOSSIER_WORKER_MODE.pdf,
      String(LIMITS.extractedContentMaxChars),
      source.mimeType,
      String(document),
    ],
    stdin: new Blob([bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    maxOutputBytes: bytes.byteLength,
  });
  if (result.isErr()) {
    const { exitCode } = result.error;
    if (exitCode === ARCHIVE_PREVIEW_WORKER_EXIT.unreadable) {
      return Result.err(
        unavailable(
          "The signed container has no readable PDF at this position",
        ),
      );
    }
    if (exitCode === ARCHIVE_PREVIEW_WORKER_EXIT.rejected) {
      return Result.err(
        unavailable("An embedded file did not pass the security scan"),
      );
    }
    return Result.err(
      new HandlerError({
        status: 503,
        code: "upstream_unavailable",
        message: "The signed container reader is unavailable",
        cause: result.error,
      }),
    );
  }
  return declaredMimeMatchesMagic(PDF_MIME_TYPE, result.value)
    ? Result.ok(result.value)
    : Result.err(
        classifyFailure(
          new HandlerError({
            status: 500,
            message: "Invalid PDF response from the signed container reader",
          }),
          "response_invalid",
        ),
      );
};
