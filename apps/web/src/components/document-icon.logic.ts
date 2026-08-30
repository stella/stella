import { PDF_MIME_TYPE } from "@/consts";
import { EML_MIME, MSG_MIME, isEmailFile, isMarkdownFile } from "@/lib/consts";

const wordMimeTypes = Object.freeze({
  "application/msword": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
});

const rtfMimeTypes = Object.freeze({
  "application/rtf": true,
  "text/rtf": true,
});

const openDocumentTextMimeTypes = Object.freeze({
  "application/vnd.oasis.opendocument.text": true,
});

// Each format carries its own mark: the Excel and Word marks are reserved for
// the formats they name, and RTF/ODT/ODS get theirs.
const excelMimeTypes = Object.freeze({
  "application/vnd.ms-excel": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
});

const powerpointMimeTypes = Object.freeze({
  "application/vnd.ms-powerpoint": true,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
});

const openDocumentSheetMimeTypes = Object.freeze({
  "application/vnd.oasis.opendocument.spreadsheet": true,
});

const csvMimeTypes = Object.freeze({
  "text/csv": true,
  "application/csv": true,
});

const imageMimeTypes = Object.freeze({
  "image/jpeg": true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true,
});

const emailMimeTypes = Object.freeze({ [EML_MIME]: true, [MSG_MIME]: true });

export type DocumentIconKind =
  | "pdf"
  | "word"
  | "rtf"
  | "openDocumentText"
  | "excel"
  | "powerpoint"
  | "openDocumentSheet"
  | "csv"
  | "image"
  | "email"
  | "markdown"
  | "text"
  | "file";

const DOCUMENT_ICON_KIND_BY_EXTENSION = {
  ".csv": "csv",
  ".doc": "word",
  ".docx": "word",
  ".eml": "email",
  ".gif": "image",
  ".jpeg": "image",
  ".jpg": "image",
  ".md": "markdown",
  ".msg": "email",
  ".ods": "openDocumentSheet",
  ".odt": "openDocumentText",
  ".pdf": "pdf",
  ".png": "image",
  ".ppt": "powerpoint",
  ".pptx": "powerpoint",
  ".rtf": "rtf",
  ".txt": "text",
  ".webp": "image",
  ".xls": "excel",
  ".xlsx": "excel",
} as const satisfies Record<string, DocumentIconKind>;

const documentIconKindForFileName = (
  fileName: string | null | undefined,
): DocumentIconKind | null => {
  const normalizedFileName = fileName?.trim().toLowerCase();
  if (!normalizedFileName) {
    return null;
  }
  for (const [extension, iconKind] of Object.entries(
    DOCUMENT_ICON_KIND_BY_EXTENSION,
  )) {
    if (normalizedFileName.endsWith(extension)) {
      return iconKind;
    }
  }
  return null;
};

export const getDocumentIconKind = (
  mimeType: string | null | undefined,
  fileName?: string | null,
): DocumentIconKind => {
  const normalizedMimeType = mimeType ?? "";
  if (normalizedMimeType === PDF_MIME_TYPE) {
    return "pdf";
  }

  if (Object.hasOwn(wordMimeTypes, normalizedMimeType)) {
    return "word";
  }

  if (Object.hasOwn(rtfMimeTypes, normalizedMimeType)) {
    return "rtf";
  }

  if (Object.hasOwn(openDocumentTextMimeTypes, normalizedMimeType)) {
    return "openDocumentText";
  }

  if (Object.hasOwn(excelMimeTypes, normalizedMimeType)) {
    return "excel";
  }

  if (Object.hasOwn(powerpointMimeTypes, normalizedMimeType)) {
    return "powerpoint";
  }

  if (Object.hasOwn(openDocumentSheetMimeTypes, normalizedMimeType)) {
    return "openDocumentSheet";
  }

  if (Object.hasOwn(csvMimeTypes, normalizedMimeType)) {
    return "csv";
  }

  if (Object.hasOwn(imageMimeTypes, normalizedMimeType)) {
    return "image";
  }

  if (
    Object.hasOwn(emailMimeTypes, normalizedMimeType) ||
    isEmailFile({ fileName, mimeType: normalizedMimeType })
  ) {
    return "email";
  }

  if (isMarkdownFile({ fileName, mimeType: normalizedMimeType })) {
    return "markdown";
  }

  const fileNameIconKind = documentIconKindForFileName(fileName);
  if (fileNameIconKind !== null) {
    return fileNameIconKind;
  }

  if (normalizedMimeType.startsWith("text/")) {
    return "text";
  }

  return "file";
};
