import { isNativelyRenderableMimeType } from "@/api/lib/files/pdf-derivative-policy";
import { isOfficeDocumentMimeType } from "@/api/lib/search/extractable-mime-types";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

export const canPrepareExtractedTextFile = (file: ResolvedFile): boolean =>
  !file.encrypted &&
  file.pdfFileId === null &&
  isNativelyRenderableMimeType(file.mimeType) &&
  isOfficeDocumentMimeType(file.mimeType);

export const isAISupportedFile = (file: ResolvedFile): boolean =>
  (file.mimeType === PDF_MIME_TYPE && !file.encrypted) ||
  file.pdfFileId !== null ||
  file.mimeType === DOCX_MIME_TYPE ||
  canPrepareExtractedTextFile(file);
