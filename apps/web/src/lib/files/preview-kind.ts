import { legalFileFormat } from "@stll/api-contract/document-format";
import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";

import {
  DOCX_MIME,
  getNativeOfficeViewerFormat,
  isEmailFile,
  isMarkdownFile,
  isPlainTextFile,
  type NativeOfficeViewerFormat,
  PDF_MIME,
} from "@/lib/consts";

type NativeFilePreviewKind =
  | "pdf"
  | "docx"
  | NativeOfficeViewerFormat
  | LegalFileFormatKind
  | "email"
  | "markdown"
  | "text";

/** A native preview works without a generated rendition. */
export const nativeFilePreviewKind = (file: {
  fileName?: string | null | undefined;
  mimeType?: string | null | undefined;
  encrypted?: boolean | undefined;
}): NativeFilePreviewKind | null => {
  if (file.mimeType === PDF_MIME) {
    return "pdf";
  }
  if (file.mimeType === DOCX_MIME) {
    return "docx";
  }
  const office = getNativeOfficeViewerFormat(file.mimeType);
  if (office !== null) {
    return office;
  }
  if (file.encrypted) {
    return null;
  }
  const legal = legalFileFormat(file.mimeType, file.fileName);
  if (legal) {
    return legal.kind;
  }
  if (isEmailFile(file)) {
    return "email";
  }
  if (isMarkdownFile(file)) {
    return "markdown";
  }
  if (isPlainTextFile(file)) {
    return "text";
  }
  return null;
};
