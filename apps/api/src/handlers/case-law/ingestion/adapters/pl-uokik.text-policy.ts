/**
 * Why a decision whose page was read holds no text, where the reason is one
 * that holds for good: its files are scans, or it has none. A row stating one
 * of these is complete without a document, so the census stops asking for it;
 * a later pass that can read scans selects exactly these rows.
 */
export const PL_UOKIK_DOCUMENT_ABSENCE = {
  /** Every decision file is an image, or a PDF without a text layer. */
  SCANNED: "scanned",
  /** The page lists no decision file. */
  NO_ATTACHMENT: "no-attachment",
} as const;

export type PlUokikDocumentAbsence =
  (typeof PL_UOKIK_DOCUMENT_ABSENCE)[keyof typeof PL_UOKIK_DOCUMENT_ABSENCE];

/** The metadata key the reason is stored under. */
export const PL_UOKIK_DOCUMENT_ABSENCE_KEY = "documentAbsence";
