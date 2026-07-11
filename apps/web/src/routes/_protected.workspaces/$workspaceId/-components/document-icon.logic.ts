import { PDF_MIME_TYPE } from "@/consts";
import { EML_MIME, MSG_MIME, isEmailFile, isMarkdownFile } from "@/lib/consts";

const wordMimeTypes = Object.freeze({
  "application/msword": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/rtf": true,
  "application/vnd.oasis.opendocument.text": true,
});

const spreadsheetMimeTypes = Object.freeze({
  "application/vnd.ms-excel": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.oasis.opendocument.spreadsheet": true,
  "text/csv": true,
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
  | "spreadsheet"
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

  if (Object.hasOwn(spreadsheetMimeTypes, mimeType)) {
    return "spreadsheet";
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
