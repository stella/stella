/**
 * Persisted-output contract: v2 adds page geometry and a searchable PDF,
 * v3 switches recognition to the local PP-OCR pipeline (line boxes are in
 * PDF point coordinates).
 */
export const DOCUMENT_OCR_PROCESSOR_VERSION = 3;

/** Both OCR providers refuse documents beyond this page count. */
export const OCR_MAX_PAGES = 500;

/** Shared PDFium raster geometry for OCR and destructive PDF rewriting. */
export const OCR_RENDER_TARGET_SCALE = 300 / 72;
export const OCR_RENDER_MAX_SIDE_PIXELS = 3600;

/**
 * File names the local OCR worker loads from the configured model
 * directory; `fetch-ocr-models.ts` downloads and pins them.
 */
export const OCR_LOCAL_MODEL_FILES = {
  detection: "ppocr-v5-mobile-det.onnx",
  recognition: "ppocr-v5-latin-rec.onnx",
} as const;

/** Persisted-output contract for sandboxed native text extraction. */
export const DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION = 1;

/** Implementation-neutral document state exposed beyond the processing slice. */
export const DOCUMENT_PROCESSING_KIND = "document-processing";
export const DOCUMENT_PROCESSING_REQUIRED_STATUS = "requires_processing";
export const DOCUMENT_PROCESSING_FAILURE_CODE = "document_processing_failed";

export type DocumentOcrLine = {
  box: readonly [number, number, number, number];
  confidence: number;
  text: string;
};

export type DocumentOcrPage = {
  height: number;
  lines: DocumentOcrLine[];
  width: number;
};

export type DocumentOcrPayload = {
  pages: DocumentOcrPage[];
  version: 1;
};

export const serializeDocumentOcrPayload = (
  payload: DocumentOcrPayload,
): string => JSON.stringify(payload);
