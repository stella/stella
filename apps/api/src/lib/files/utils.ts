import { Result, TaggedError } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import {
  createFileKey,
  createOcrSearchablePdfKey,
  createUserFileKey,
  getFileExtension,
} from "@/api/lib/file-key";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";
import {
  DOCM_MIME_TYPE,
  DOCX_MIME_TYPE,
  DOC_MIME_TYPE,
  EPUB_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PDF_MIME_TYPE,
  PPSX_MIME_TYPE,
  PPTX_MIME_TYPE,
  PPT_MIME_TYPE,
  RTF_MIME_TYPE,
  XLSB_MIME_TYPE,
  XLSX_MIME_TYPE,
  XLS_MIME_TYPE,
} from "@/api/mime-types";

export {
  createFileKey,
  createOcrSearchablePdfKey,
  createUserFileKey,
  getFileExtension,
};

/**
 * MIME types browsers report when they have no registered handler
 * for a file (so `File.type` arrives empty or generic). For these
 * we trust the filename extension instead.
 */
const GENERIC_UPLOAD_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

/**
 * Supported document extensions worth recovering from a generic MIME type.
 * Without this, previews, derivatives, scanning, and extraction all make
 * decisions from an unusable octet-stream declaration.
 */
const EXTENSION_MIME_OVERRIDES: Record<string, string> = {
  csv: "text/csv",
  doc: DOC_MIME_TYPE,
  docm: DOCM_MIME_TYPE,
  docx: DOCX_MIME_TYPE,
  eml: "message/rfc822",
  epub: EPUB_MIME_TYPE,
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  msg: "application/vnd.ms-outlook",
  odp: ODP_MIME_TYPE,
  ods: ODS_MIME_TYPE,
  odt: ODT_MIME_TYPE,
  pdf: PDF_MIME_TYPE,
  ppsx: PPSX_MIME_TYPE,
  ppt: PPT_MIME_TYPE,
  pptx: PPTX_MIME_TYPE,
  rtf: RTF_MIME_TYPE,
  text: "text/plain",
  txt: "text/plain",
  xls: XLS_MIME_TYPE,
  xlsb: XLSB_MIME_TYPE,
  xlsx: XLSX_MIME_TYPE,
};

type ResolveUploadMimeProps = {
  declaredMime: string;
  fileName: string;
};

/**
 * Normalize a client-declared upload MIME type: when the browser
 * reports a generic/empty type, fall back to a known type inferred
 * from the filename extension. Well-typed uploads pass through
 * unchanged.
 */
export const resolveUploadMime = ({
  declaredMime,
  fileName,
}: ResolveUploadMimeProps): string => {
  if (!GENERIC_UPLOAD_MIME_TYPES.has(declaredMime)) {
    return declaredMime;
  }
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return declaredMime;
  }
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_MIME_OVERRIDES[extension] ?? declaredMime;
};

/**
 * Concurrency limit for individual S3 delete calls. Bun's
 * S3Client has no batch-delete API, so we chunk to avoid
 * overwhelming the endpoint with concurrent HTTP requests.
 */
const S3_DELETE_CONCURRENCY = 50;
const S3_DELETE_TIMEOUT_MS = 30 * 1000;

type DeleteS3ObjectsProps = {
  fileRows: { fileId: string; mimeType: string }[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

class S3Error extends TaggedError("S3Error")<{
  message: string;
  code?: string | undefined;
  key?: string | undefined;
  cause?: unknown;
}> {}

export const deleteS3Objects = async ({
  fileRows,
  organizationId,
  workspaceId,
}: DeleteS3ObjectsProps): Promise<Result<void, S3Error>> => {
  const keys = fileRows.map(({ fileId, mimeType }) =>
    createFileKey({
      organizationId,
      workspaceId,
      fileId,
      mimeType,
    }),
  );

  return await deleteS3Keys(keys);
};

export const deleteS3Keys = async (
  keys: string[],
): Promise<Result<void, S3Error>> => {
  const dedupedKeys = keys.filter((key, index) => keys.indexOf(key) === index);

  for (let i = 0; i < dedupedKeys.length; i += S3_DELETE_CONCURRENCY) {
    const chunk = dedupedKeys.slice(i, i + S3_DELETE_CONCURRENCY);

    // oxlint-disable-next-line no-await-in-loop -- chunks run sequentially for bounded S3 concurrency and early return on the first failed chunk
    const result = await Result.tryPromise(
      async () =>
        await Promise.all(
          chunk.map(
            async (key) =>
              await withTimeout(
                async (signal) => await deleteS3ObjectWithSignal(key, signal),
                {
                  label: "s3-object-delete",
                  timeoutMs: S3_DELETE_TIMEOUT_MS,
                },
              ),
          ),
        ),
    );

    if (Result.isError(result)) {
      return Result.err(
        new S3Error({
          message: `Failed to delete S3 objects (${chunk.length} keys in chunk)`,
          key: chunk.at(0),
          cause: result.error,
        }),
      );
    }
  }

  return Result.ok();
};
