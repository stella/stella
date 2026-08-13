/** Persisted-output contract: v2 adds page geometry and a searchable PDF. */
export const DOCUMENT_OCR_PROCESSOR_VERSION = 2;

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
