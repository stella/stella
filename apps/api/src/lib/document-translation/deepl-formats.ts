import { DOC_MIME_TYPE, DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

export const DEEPL_SUPPORTED_MIME_TYPES = new Set<string>([
  DOC_MIME_TYPE,
  DOCX_MIME_TYPE,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PDF_MIME_TYPE,
  "text/plain",
  "text/html",
  "application/xliff+xml",
]);

export const isDeepLSupportedMimeType = (mimeType: string): boolean =>
  DEEPL_SUPPORTED_MIME_TYPES.has(mimeType);
