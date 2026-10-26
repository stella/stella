/** The public-law documents a reader marks: their text, open to every reader. */
export const READER_DOCUMENT_TARGET_TYPES = ["decision", "statute"] as const;
export type ReaderDocumentTargetType =
  (typeof READER_DOCUMENT_TARGET_TYPES)[number];

/**
 * What a reader's mark sits on: a public-law document, or one claim of a
 * matter's document verification. A claim's notes belong to the matter and
 * are read and written only through the verification routes.
 */
export const READER_ANNOTATION_TARGET_TYPES = [
  ...READER_DOCUMENT_TARGET_TYPES,
  "verification-claim",
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
