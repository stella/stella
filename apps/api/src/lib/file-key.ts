import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";

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

type CreateFileKeyProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  fileId: string;
  mimeType: string;
};

/**
 * An object key under which only scanned uploads or server-built output are
 * stored. Reading one back is how `storedFile` proves bytes may reach a
 * parser, so presigned staging keys must never be minted as a `FileKey`. The
 * key builders below and `tests/helpers/file-key.ts` are the only modules the
 * `scanned-file-boundary` lint rule lets parse with this schema.
 */
export const fileKeySchema = v.pipe(v.string(), v.brand("FileKey"));

export type FileKey = v.InferOutput<typeof fileKeySchema>;

export const createFileKey = ({
  organizationId,
  workspaceId,
  fileId,
  mimeType,
}: CreateFileKeyProps): FileKey =>
  v.parse(
    fileKeySchema,
    `${organizationId}/${workspaceId}/${fileId}.${getFileExtension(mimeType)}`,
  );

type CreateOcrDerivativeKeyProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentProcessingRun">;
};

/** Deterministic key: retries overwrite the same immutable-source derivative. */
export const createOcrSearchablePdfKey = ({
  organizationId,
  workspaceId,
  runId,
}: CreateOcrDerivativeKeyProps): string =>
  `${organizationId}/${workspaceId}/ocr/${runId}.pdf`;

type CreateUserFileKeyProps = {
  fileId: string;
  mimeType: string;
  userId: SafeId<"user">;
};

export const createUserFileKey = ({
  fileId,
  mimeType,
  userId,
}: CreateUserFileKeyProps): FileKey =>
  // Chat attachments are scanned before they are written here
  // (`uploadMessageFiles`), so the key addresses scanned bytes.
  v.parse(fileKeySchema, `${userId}/${fileId}.${getFileExtension(mimeType)}`);
