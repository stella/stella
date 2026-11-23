import { previewedDocumentFormatOfFileName } from "@stll/api-contract/converted-document-formats";

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

/** Archive types a client declares for any ZIP package. */
const ZIP_ARCHIVE_UPLOAD_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
]);

const UPLOAD_MIME_TYPE_ALIASES = new Map([
  ["application/x-pdf", "application/pdf"],
  ["image/jpg", "image/jpeg"],
]);

type ResolveUploadMimeProps = {
  declaredMime: string;
  fileName: string;
};

const MAX_MIME_EXTENSION_LENGTH = 32;
const SAFE_MIME_EXTENSION_RE = /^[a-z0-9]{1,32}$/u;

/**
 * Normalize a client-declared upload MIME type: when the browser
 * reports a generic/empty type, fall back to a known type inferred
 * from the filename extension, as for a ZIP-packaged document format
 * declared as a plain ZIP archive. Well-typed uploads pass through
 * unchanged.
 */
export const resolveUploadMime = ({
  declaredMime,
  fileName,
}: ResolveUploadMimeProps): string => {
  const canonicalDeclaredMime =
    UPLOAD_MIME_TYPE_ALIASES.get(declaredMime) ?? declaredMime;
  // A Pages or Numbers file is a ZIP package, so it often arrives declared
  // as a plain ZIP archive; its name says which package it is.
  const zipPackage = ZIP_ARCHIVE_UPLOAD_MIME_TYPES.has(canonicalDeclaredMime)
    ? previewedDocumentFormatOfFileName(fileName)
    : undefined;
  if (zipPackage?.zipPackage === true) {
    return zipPackage.mimeType;
  }
  if (!GENERIC_UPLOAD_MIME_TYPES.has(canonicalDeclaredMime)) {
    return canonicalDeclaredMime;
  }
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return canonicalDeclaredMime;
  }
  // Some converted formats go by extensions no media type table lists
  // (WordPerfect's `.wp5`).
  const converted = previewedDocumentFormatOfFileName(fileName);
  if (converted !== undefined) {
    return converted.mimeType;
  }
  const extension = fileName
    .slice(dotIndex + 1, dotIndex + 1 + MAX_MIME_EXTENSION_LENGTH)
    .toLowerCase();
  if (!SAFE_MIME_EXTENSION_RE.test(extension)) {
    return canonicalDeclaredMime;
  }
  const lookupName = `file.${extension}`;
  return (
    Bun.file(lookupName).type.split(";").at(0)?.trim() || canonicalDeclaredMime
  );
};
