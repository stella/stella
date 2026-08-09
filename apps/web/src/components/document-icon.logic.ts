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

export const getDocumentIconKind = (
  mimeType: string,
  fileName?: string | null,
): DocumentIconKind => {
  if (mimeType === PDF_MIME_TYPE) {
    return "pdf";
  }

  if (Object.hasOwn(wordMimeTypes, mimeType)) {
    return "word";
  }

  if (Object.hasOwn(rtfMimeTypes, mimeType)) {
    return "rtf";
  }

  if (Object.hasOwn(openDocumentTextMimeTypes, mimeType)) {
    return "openDocumentText";
  }

  if (Object.hasOwn(excelMimeTypes, mimeType)) {
    return "excel";
  }

  if (Object.hasOwn(powerpointMimeTypes, mimeType)) {
    return "powerpoint";
  }

  if (Object.hasOwn(openDocumentSheetMimeTypes, mimeType)) {
    return "openDocumentSheet";
  }

  if (Object.hasOwn(csvMimeTypes, mimeType)) {
    return "csv";
  }

  if (Object.hasOwn(imageMimeTypes, mimeType)) {
    return "image";
  }

  if (
    Object.hasOwn(emailMimeTypes, mimeType) ||
    isEmailFile({ fileName, mimeType })
  ) {
    return "email";
  }

  if (isMarkdownFile({ fileName, mimeType })) {
    return "markdown";
  }

  if (mimeType.startsWith("text/")) {
    return "text";
  }

  return "file";
};
