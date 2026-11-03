import { panic } from "better-result";
import * as v from "valibot";

import {
  READER_ANNOTATION_BODY_MAX_LENGTH,
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_MAX_SPANS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_ANNOTATION_STYLES,
  READER_ANNOTATION_VISIBILITIES,
  READER_DOCUMENT_TARGET_TYPES,
} from "@stll/api-contract/legal-reader-annotations";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
  ReaderAnnotationTargetType,
  ReaderAnnotationVisibility,
  ReaderDocumentTargetType,
} from "@stll/api-contract/legal-reader-annotations";
import { READER_TEXT_QUOTE_CONTEXT_LENGTH } from "@stll/legal-ast/reader-text-quote";

import { resourceIdSchema, uuidSchema } from "@/api/lib/custom-schema";

// The public-law routes and tools address documents only; a claim's comment
// goes through its matter's verification routes.
const ANNOTATION_TARGET_TYPE_SCHEMA_VALUES = [
  READER_DOCUMENT_TARGET_TYPES[0],
  READER_DOCUMENT_TARGET_TYPES[1],
] as const satisfies readonly ReaderDocumentTargetType[];
const ANNOTATION_COLOR_SCHEMA_VALUES = [
  READER_ANNOTATION_COLORS[0],
  READER_ANNOTATION_COLORS[1],
  READER_ANNOTATION_COLORS[2],
  READER_ANNOTATION_COLORS[3],
  READER_ANNOTATION_COLORS[4],
] as const satisfies readonly ReaderAnnotationColor[];
const ANNOTATION_STYLE_SCHEMA_VALUES = [
  READER_ANNOTATION_STYLES[0],
  READER_ANNOTATION_STYLES[1],
  READER_ANNOTATION_STYLES[2],
  READER_ANNOTATION_STYLES[3],
] as const satisfies readonly ReaderAnnotationStyle[];
const ANNOTATION_VISIBILITY_SCHEMA_VALUES = [
  READER_ANNOTATION_VISIBILITIES[0],
  READER_ANNOTATION_VISIBILITIES[1],
] as const satisfies readonly ReaderAnnotationVisibility[];

type MissingAnnotationTargetType = Exclude<
  ReaderDocumentTargetType,
  (typeof ANNOTATION_TARGET_TYPE_SCHEMA_VALUES)[number]
>;
type MissingAnnotationColor = Exclude<
  ReaderAnnotationColor,
  (typeof ANNOTATION_COLOR_SCHEMA_VALUES)[number]
>;
type MissingAnnotationStyle = Exclude<
  ReaderAnnotationStyle,
  (typeof ANNOTATION_STYLE_SCHEMA_VALUES)[number]
>;
type MissingAnnotationVisibility = Exclude<
  ReaderAnnotationVisibility,
  (typeof ANNOTATION_VISIBILITY_SCHEMA_VALUES)[number]
>;

true satisfies MissingAnnotationTargetType extends never ? true : never;
true satisfies MissingAnnotationColor extends never ? true : never;
true satisfies MissingAnnotationStyle extends never ? true : never;
true satisfies MissingAnnotationVisibility extends never ? true : never;

export const annotationTargetTypeSchema = v.union([
  v.literal(ANNOTATION_TARGET_TYPE_SCHEMA_VALUES[0]),
  v.literal(ANNOTATION_TARGET_TYPE_SCHEMA_VALUES[1]),
]);
export const annotationColorSchema = v.union([
  v.literal(ANNOTATION_COLOR_SCHEMA_VALUES[0]),
  v.literal(ANNOTATION_COLOR_SCHEMA_VALUES[1]),
  v.literal(ANNOTATION_COLOR_SCHEMA_VALUES[2]),
  v.literal(ANNOTATION_COLOR_SCHEMA_VALUES[3]),
  v.literal(ANNOTATION_COLOR_SCHEMA_VALUES[4]),
]);
export const annotationStyleSchema = v.union([
  v.literal(ANNOTATION_STYLE_SCHEMA_VALUES[0]),
  v.literal(ANNOTATION_STYLE_SCHEMA_VALUES[1]),
  v.literal(ANNOTATION_STYLE_SCHEMA_VALUES[2]),
  v.literal(ANNOTATION_STYLE_SCHEMA_VALUES[3]),
]);
export const annotationVisibilitySchema = v.union([
  v.literal(ANNOTATION_VISIBILITY_SCHEMA_VALUES[0]),
  v.literal(ANNOTATION_VISIBILITY_SCHEMA_VALUES[1]),
]);

/** The route schema has validated these values; preserve its closed domain. */
export const requireAnnotationTargetType = (
  value: string,
): ReaderAnnotationTargetType => {
  switch (value) {
    case "decision":
    case "statute":
    case "verification-claim":
    case "matter-document":
      return value;
    default:
      return panic(`Invalid annotation target type: ${value}`);
  }
};

export const requireAnnotationColor = (
  value: string,
): ReaderAnnotationColor => {
  switch (value) {
    case "yellow":
    case "green":
    case "sky":
    case "violet":
    case "red":
      return value;
    default:
      return panic(`Invalid annotation color: ${value}`);
  }
};

export const requireAnnotationStyle = (
  value: string,
): ReaderAnnotationStyle => {
  switch (value) {
    case "highlight":
    case "underline":
    case "squiggly":
    case "strikethrough":
      return value;
    default:
      return panic(`Invalid annotation style: ${value}`);
  }
};

export const requireAnnotationVisibility = (
  value: string,
): ReaderAnnotationVisibility => {
  switch (value) {
    case "private":
    case "shared":
      return value;
    default:
      return panic(`Invalid annotation visibility: ${value}`);
  }
};

/**
 * The document a mark sits on: the corpus, and the id within it. The id is a
 * plain UUID rather than a branded one because the brand differs with the
 * corpus; `targetType` is what says which identity it is.
 */
const targetSchemaFields = {
  targetType: annotationTargetTypeSchema,
  targetId: uuidSchema,
} as const;

/** The text either side of a quote in its block; empty at a block edge. */
const quoteContextSchema = v.pipe(
  v.string(),
  v.maxLength(READER_TEXT_QUOTE_CONTEXT_LENGTH),
);

/**
 * Where on the document one paragraph's share of the annotation sits, and
 * the words it covers with their context: after a re-parse the position can
 * name other words, the quote cannot.
 */
const spanSchema = v.object({
  blockAnchorId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  startOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
  endOffset: v.pipe(v.number(), v.integer(), v.minValue(1)),
  quote: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(READER_ANNOTATION_QUOTE_MAX_LENGTH),
  ),
  // Optional so a reader page loaded before the context was kept can still
  // save: a span without it is stored with none, and placed by its stored
  // position and words like a mark made before the context existed.
  quotePrefix: v.optional(quoteContextSchema, ""),
  quoteSuffix: v.optional(quoteContextSchema, ""),
});

const spansSchema = v.pipe(
  v.array(spanSchema),
  v.minLength(1),
  v.maxLength(READER_ANNOTATION_MAX_SPANS),
);

/** A comment's words, on every route that writes one. */
export const annotationCommentTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(READER_ANNOTATION_BODY_MAX_LENGTH),
);

/**
 * One body per kind, so a highlight cannot carry words and a comment cannot
 * arrive without them; the database CHECK says the same.
 */
export const createAnnotationBodySchema = v.union([
  v.object({
    ...targetSchemaFields,
    kind: v.literal("highlight"),
    color: annotationColorSchema,
    style: annotationStyleSchema,
    requestId: v.optional(resourceIdSchema("legalReaderAnnotation")),
    visibility: v.optional(annotationVisibilitySchema),
    spans: spansSchema,
  }),
  v.object({
    ...targetSchemaFields,
    kind: v.literal("comment"),
    body: annotationCommentTextSchema,
    requestId: v.optional(resourceIdSchema("legalReaderAnnotation")),
    visibility: v.optional(annotationVisibilitySchema),
    spans: spansSchema,
  }),
]);

export type CreateAnnotationBody = v.InferOutput<
  typeof createAnnotationBodySchema
>;

type WithTargetType<TBody, TTarget> = TBody extends unknown
  ? Omit<TBody, "targetType"> & { targetType: TTarget }
  : never;

/**
 * A new mark as the operation receives it, on any target. The public-law
 * route validates `CreateAnnotationBody`; the claim route builds a
 * `verification-claim` request from the claim it read.
 */
export type CreateAnnotationRequest = WithTargetType<
  CreateAnnotationBody,
  ReaderAnnotationTargetType
>;

/** One change per request, named, so an update cannot be empty or ambiguous. */
export const updateAnnotationBodySchema = v.union([
  v.object({
    change: v.literal("body"),
    body: annotationCommentTextSchema,
  }),
  v.object({ change: v.literal("color"), color: annotationColorSchema }),
  v.object({ change: v.literal("style"), style: annotationStyleSchema }),
  v.object({
    change: v.literal("visibility"),
    visibility: annotationVisibilitySchema,
  }),
]);

export type UpdateAnnotationBody = v.InferOutput<
  typeof updateAnnotationBodySchema
>;

export const annotationParamsSchema = v.object({
  annotationId: resourceIdSchema("legalReaderAnnotation"),
});
