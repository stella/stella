/**
 * Whether this deployment accepts document OCR requests, and when they run.
 * `live`: a worker is processing now. `batched`: no worker is live, but one
 * ran recently enough that a queued request is picked up by the next batch.
 * `unconfigured`: no worker has run recently, so a request would not run.
 */
export const DOCUMENT_OCR_AVAILABILITY = {
  live: { type: "live" },
  batched: { type: "batched" },
  unconfigured: { type: "unconfigured" },
} as const;

export type DocumentOcrAvailability =
  (typeof DOCUMENT_OCR_AVAILABILITY)[keyof typeof DOCUMENT_OCR_AVAILABILITY];

export type AcceptingDocumentOcrAvailability = Exclude<
  DocumentOcrAvailability,
  typeof DOCUMENT_OCR_AVAILABILITY.unconfigured
>;

/** The one admission rule shared by the UI gate and the request endpoint. */
export const acceptsDocumentOcrRequests = (
  availability: DocumentOcrAvailability,
): availability is AcceptingDocumentOcrAvailability =>
  availability.type !== DOCUMENT_OCR_AVAILABILITY.unconfigured.type;
