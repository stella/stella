export const OCR_EXPORT_STATUSES = [
  "text-and-pdf",
  "text",
  "unavailable",
] as const;

export type OcrExportStatus = (typeof OCR_EXPORT_STATUSES)[number];
