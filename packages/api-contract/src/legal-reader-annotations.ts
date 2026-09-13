/** Which document a reader's mark sits on. */
export const READER_ANNOTATION_TARGET_TYPES = ["decision", "statute"] as const;
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
