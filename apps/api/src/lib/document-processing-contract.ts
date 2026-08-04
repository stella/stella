/** Persisted-output contract: v2 adds page geometry and a searchable PDF. */
export const DOCUMENT_OCR_PROCESSOR_VERSION = 2;

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
