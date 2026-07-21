import path from "node:path";

const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * Document and evidence formats Stella can preserve or derive previews from.
 * Keeping the lookup local makes the published CLI Node-compatible without a
 * dependency solely for extension metadata.
 */
const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".eml": "message/rfc822",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".msg": "application/vnd.ms-outlook",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

export const inferFileMimeType = (filePath: string): string =>
  MIME_TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ??
  DEFAULT_MIME_TYPE;
