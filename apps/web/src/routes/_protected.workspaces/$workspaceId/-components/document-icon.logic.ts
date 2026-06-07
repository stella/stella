import { PDF_MIME_TYPE } from "@/consts";
import { EML_MIME, MSG_MIME, isEmailFile, isMarkdownFile } from "@/lib/consts";

const wordMimeTypes = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
]);

const spreadsheetMimeTypes = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
]);

const imageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const emailMimeTypes = new Set<string>([EML_MIME, MSG_MIME]);

export type DocumentIconKind =
  | "pdf"
  | "word"
  | "spreadsheet"
  | "image"
  | "email"
  | "text"
  | "file";

export const getDocumentIconKind = (
  mimeType: string,
  fileName?: string | null,
): DocumentIconKind => {
  if (mimeType === PDF_MIME_TYPE) {
    return "pdf";
  }

  if (wordMimeTypes.has(mimeType)) {
    return "word";
  }

  if (spreadsheetMimeTypes.has(mimeType)) {
    return "spreadsheet";
  }

  if (imageMimeTypes.has(mimeType)) {
    return "image";
  }

  if (emailMimeTypes.has(mimeType) || isEmailFile({ fileName, mimeType })) {
    return "email";
  }

  if (mimeType.startsWith("text/") || isMarkdownFile({ fileName, mimeType })) {
    return "text";
  }

  return "file";
};
