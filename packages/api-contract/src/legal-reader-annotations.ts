/** The public-law documents a reader marks: their text, open to every reader. */
export const READER_DOCUMENT_TARGET_TYPES = ["decision", "statute"] as const;
export type ReaderDocumentTargetType =
  (typeof READER_DOCUMENT_TARGET_TYPES)[number];

/**
 * Matter content a mark sits on: one claim of a matter's document
 * verification, or a passage of a matter document's PDF. These notes belong
 * to the matter and are read and written only through the matter's routes.
 */
export const READER_MATTER_TARGET_TYPES = [
  "verification-claim",
  "matter-document",
] as const;
export type ReaderMatterTargetType =
  (typeof READER_MATTER_TARGET_TYPES)[number];

/** What a reader's mark sits on: a public-law document or matter content. */
export const READER_ANNOTATION_TARGET_TYPES = [
  ...READER_DOCUMENT_TARGET_TYPES,
  ...READER_MATTER_TARGET_TYPES,
] as const;
export type ReaderAnnotationTargetType =
  (typeof READER_ANNOTATION_TARGET_TYPES)[number];

/** What a reader leaves on a document's text. */
export const READER_ANNOTATION_KINDS = ["highlight", "comment"] as const;
export type ReaderAnnotationKind = (typeof READER_ANNOTATION_KINDS)[number];

/** Who besides the author sees an annotation. */
export const READER_ANNOTATION_VISIBILITIES = ["private", "shared"] as const;
export type ReaderAnnotationVisibility =
  (typeof READER_ANNOTATION_VISIBILITIES)[number];

/** Highlight swatches, named after the design system's option palette. */
export const READER_ANNOTATION_COLORS = [
  "yellow",
  "green",
  "sky",
  "violet",
  "red",
] as const;
export type ReaderAnnotationColor = (typeof READER_ANNOTATION_COLORS)[number];

/** How a highlight is drawn. */
export const READER_ANNOTATION_STYLES = [
  "highlight",
  "underline",
  "squiggly",
  "strikethrough",
] as const;
export type ReaderAnnotationStyle = (typeof READER_ANNOTATION_STYLES)[number];

/** Bounds shared by the API validator and the guest annotation store. */
export const READER_ANNOTATION_MAX_SPANS = 40;
export const READER_ANNOTATION_QUOTE_MAX_LENGTH = 2000;
export const READER_ANNOTATION_BODY_MAX_LENGTH = 10_000;

/**
 * The ways a cited passage is copied for a brief: the quotation with its
 * citation in either order, as a block, alone, or the citation alone.
 */
export const READER_COPY_MODES = [
  "quoteWithCitation",
  "citationWithQuote",
  "blockQuoteWithCitation",
  "textOnly",
  "citationOnly",
] as const;
export type ReaderCopyMode = (typeof READER_COPY_MODES)[number];

/** How a PDF page's block anchor starts; the page number follows. */
export const READER_PDF_PAGE_ANCHOR_PREFIX = "page-";
/** The last page a PDF anchor can name: six digits, as the database check
 *  allows. */
export const READER_PDF_PAGE_NUMBER_MAX = 999_999;

/** The block a mark on one page of a PDF sits in, by the page's 1-based number. */
export const readerPdfPageAnchorId = (pageNumber: number): string =>
  `${READER_PDF_PAGE_ANCHOR_PREFIX}${String(pageNumber)}`;

/**
 * Why a mark on a matter document's PDF was refused, as the error `code` the
 * API answers with: the file is not a readable PDF, the page is not in it or
 * has no text to mark, or the selected words are not the page's words.
 */
export const MATTER_DOCUMENT_ANNOTATION_REFUSALS = {
  fileNotPdf: "annotation_file_not_pdf",
  fileEncrypted: "annotation_file_encrypted",
  pageMissing: "annotation_page_missing",
  pageWithoutText: "annotation_page_without_text",
  quoteMismatch: "annotation_quote_mismatch",
} as const;
export type MatterDocumentAnnotationRefusal =
  (typeof MATTER_DOCUMENT_ANNOTATION_REFUSALS)[keyof typeof MATTER_DOCUMENT_ANNOTATION_REFUSALS];
