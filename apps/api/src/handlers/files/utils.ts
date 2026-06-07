import { Result, TaggedError } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { getS3 } from "@/api/lib/s3";

const fileExtensionMap: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "application/zip": "zip",
  "application/json": "json",
  "application/xml": "xml",
  "message/rfc822": "eml",
  "application/vnd.ms-outlook": "msg",
  "application/rtf": "rtf",
};

export const getFileExtension = (mimeType: string): string =>
  fileExtensionMap[mimeType] ?? "bin";

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
 * Extensions worth recovering from a generic MIME type. Outlook
 * `.msg` in particular is usually reported as octet-stream on
 * machines without Outlook; `.eml` occasionally too. Without this
 * the file would never get a PDF derivative for preview.
 */
const EXTENSION_MIME_OVERRIDES: Record<string, string> = {
  eml: "message/rfc822",
  markdown: "text/markdown",
  md: "text/markdown",
  msg: "application/vnd.ms-outlook",
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

type CreateFileKeyProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  fileId: string;
  mimeType: string;
};

export const createFileKey = ({
  organizationId,
  workspaceId,
  fileId,
  mimeType,
}: CreateFileKeyProps) =>
  `${organizationId}/${workspaceId}/${fileId}.${getFileExtension(mimeType)}`;

type CreateUserFileKeyProps = {
  fileId: string;
  mimeType: string;
  userId: SafeId<"user">;
};

export const createUserFileKey = ({
  fileId,
  mimeType,
  userId,
}: CreateUserFileKeyProps) =>
  `${userId}/${fileId}.${getFileExtension(mimeType)}`;

/**
 * Concurrency limit for individual S3 delete calls. Bun's
 * S3Client has no batch-delete API, so we chunk to avoid
 * overwhelming the endpoint with concurrent HTTP requests.
 */
const S3_DELETE_CONCURRENCY = 50;

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
}>() {}

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

    const result = await Result.tryPromise(
      async () =>
        await Promise.all(chunk.map(async (key) => await getS3().delete(key))),
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
