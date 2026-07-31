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
