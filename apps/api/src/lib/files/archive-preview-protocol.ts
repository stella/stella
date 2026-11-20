import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";
import { STRUCTURED_DOCUMENT_FORMATS } from "@stll/api-contract/structured-document-formats";

const DOCUMENT_ARCHIVE_FORMATS = [
  ...ASIC_FILE_FORMATS,
  ...STRUCTURED_DOCUMENT_FORMATS,
];

export const isDocumentArchiveMimeType = (mimeType: string): boolean =>
  DOCUMENT_ARCHIVE_FORMATS.some((format) => format.mimeType === mimeType);

export const DOCUMENT_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export const ASIC_PREVIEW_WORKER_MODE = "asic-preview";

export const STRUCTURED_DOCUMENT_PREVIEW_MODE = "structured-document-preview";

export const ARCHIVE_PREVIEW_WORKER_EXIT = {
  unreadable: 20,
  rejected: 21,
} as const;
