import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { asicPreviewSchema } from "@stll/api-contract/asic";
import { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import { structuredDocumentPreviewSchema } from "@stll/api-contract/structured-document";
import { zipArchivePreviewSchema } from "@stll/api-contract/zip-archive";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  ARCHIVE_PREVIEW_WORKER_EXIT,
  ASIC_PREVIEW_WORKER_MODE,
  DOCUMENT_ARCHIVE_MAX_BYTES,
  SIGNED_DOSSIER_WORKER_MODE,
  STRUCTURED_DOCUMENT_PREVIEW_MODE,
  ZIP_ARCHIVE_PREVIEW_MODE,
} from "@/api/lib/files/archive-preview-protocol";
import type { ZipNameCodePage } from "@/api/lib/files/zip-name-code-page";
import { LIMITS } from "@/api/lib/limits";
import { runExtractionBinaryWorker } from "@/api/lib/search/extract-content";

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
    {
      zipNameCodePage,
      expectedMimeType = source.mimeType,
    }: {
      zipNameCodePage: ZipNameCodePage | null;
      expectedMimeType?: string | undefined;
    },
  ): Promise<Result<v.InferOutput<Schema>, HandlerError<422 | 500 | 503>>> => {
    const { bytes } = source;
    if (bytes.byteLength > DOCUMENT_ARCHIVE_MAX_BYTES) {
      return Result.err(
        unavailable(`The ${label} file exceeds the preview size limit`),
      );
    }

    const result = await runExtractionBinaryWorker({
      zipNameCodePage,
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

/**
 * How a preview that reads the files it holds is run: one of them may be a
 * ZIP archive, whose names tie in the reading organization's code page.
 */
export type ArchivePreviewRun = {
  zipNameCodePage: ZipNameCodePage;
  expectedMimeType?: string | undefined;
};

const asicPreview = archivePreviewReader({
  mode: ASIC_PREVIEW_WORKER_MODE,
  schema: asicPreviewSchema,
  label: "ASiC",
});
export const readAsicPreview = async (
  source: ScannedFile,
  run: ArchivePreviewRun,
) => await asicPreview(source, run);

const structuredDocumentPreview = archivePreviewReader({
  mode: STRUCTURED_DOCUMENT_PREVIEW_MODE,
  schema: structuredDocumentPreviewSchema,
  label: "document",
});
/** An OFD or UDF document; its reader opens no ZIP archive's names. */
export const readStructuredDocumentPreview = async (
  source: ScannedFile,
  expectedMimeType?: string,
) =>
  await structuredDocumentPreview(source, {
    zipNameCodePage: null,
    expectedMimeType,
  });

const zipArchivePreview = archivePreviewReader({
  mode: ZIP_ARCHIVE_PREVIEW_MODE,
  schema: zipArchivePreviewSchema,
  label: "ZIP archive",
});
export const readZipArchivePreview = async (
  source: ScannedFile,
  run: ArchivePreviewRun,
) => await zipArchivePreview(source, run);

const signedDossierPreview = archivePreviewReader({
  mode: SIGNED_DOSSIER_WORKER_MODE.preview,
  schema: signedDossierPreviewSchema,
  label: "signed container",
});
export const readSignedDossierPreview = async (
  source: ScannedFile,
  run: ArchivePreviewRun,
) => await signedDossierPreview(source, run);
