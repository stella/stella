/** What a reader leaves on a decision's text. */
export const CASE_LAW_ANNOTATION_KINDS = ["highlight", "comment"] as const;
export type CaseLawAnnotationKind = (typeof CASE_LAW_ANNOTATION_KINDS)[number];

/** Who besides the author sees an annotation. */
export const CASE_LAW_ANNOTATION_VISIBILITIES = ["private", "shared"] as const;
export type CaseLawAnnotationVisibility =
  (typeof CASE_LAW_ANNOTATION_VISIBILITIES)[number];

/** Highlight swatches, named after the design system's option palette. */
export const CASE_LAW_ANNOTATION_COLORS = [
  "yellow",
  "green",
  "sky",
  "violet",
  "red",
] as const;
export type CaseLawAnnotationColor =
  (typeof CASE_LAW_ANNOTATION_COLORS)[number];

/** How a highlight is drawn. */
export const CASE_LAW_ANNOTATION_STYLES = [
  "highlight",
  "underline",
  "squiggly",
  "strikethrough",
] as const;
export type CaseLawAnnotationStyle =
  (typeof CASE_LAW_ANNOTATION_STYLES)[number];

/** Bounds shared by the API validator and the guest annotation store. */
export const CASE_LAW_ANNOTATION_MAX_SPANS = 40;
export const CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH = 2000;
export const CASE_LAW_ANNOTATION_BODY_MAX_LENGTH = 10_000;
