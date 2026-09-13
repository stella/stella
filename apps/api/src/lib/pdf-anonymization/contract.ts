export const PDF_ANONYMIZATION_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;

export type PdfAnonymizationRunStatus =
  (typeof PDF_ANONYMIZATION_RUN_STATUSES)[number];

export const PDF_ANONYMIZATION_RUN_ACTIVE_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly PdfAnonymizationRunStatus[];

export const PDF_ANONYMIZATION_ERROR_CODE = {
  encryptedPdf: "encrypted_pdf",
  internal: "internal",
  invalidPdf: "invalid_pdf",
  ocrFailed: "ocr_failed",
  ocrNotConfigured: "ocr_not_configured",
  outputRejected: "output_rejected",
  rewriteFailed: "rewrite_failed",
  sourceChanged: "source_changed",
} as const;

export const PDF_ANONYMIZATION_ERROR_CODES = Object.values(
  PDF_ANONYMIZATION_ERROR_CODE,
);

export type PdfAnonymizationErrorCode =
  (typeof PDF_ANONYMIZATION_ERROR_CODES)[number];

export const PDF_ANONYMIZATION_PIPELINE_VERSION = 1;
export const PDF_ANONYMIZATION_OCR_LANGUAGE = "latin";
export const PDF_ANONYMIZATION_WORKER_TIMEOUT_MS = 45 * 60 * 1000;
