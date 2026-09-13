import { panic } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  READER_ANNOTATION_BODY_MAX_LENGTH,
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_MAX_SPANS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_ANNOTATION_STYLES,
  READER_ANNOTATION_TARGET_TYPES,
  READER_ANNOTATION_VISIBILITIES,
} from "@stll/api-contract/legal-reader-annotations";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
  ReaderAnnotationTargetType,
  ReaderAnnotationVisibility,
} from "@stll/api-contract/legal-reader-annotations";

import { tSafeId, tUuid } from "@/api/lib/custom-schema";

const ANNOTATION_TARGET_TYPE_SCHEMA_VALUES = [
  READER_ANNOTATION_TARGET_TYPES[0],
  READER_ANNOTATION_TARGET_TYPES[1],
] as const satisfies readonly ReaderAnnotationTargetType[];
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
  ReaderAnnotationTargetType,
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

export const annotationTargetTypeSchema = t.Union([
  t.Literal(ANNOTATION_TARGET_TYPE_SCHEMA_VALUES[0]),
  t.Literal(ANNOTATION_TARGET_TYPE_SCHEMA_VALUES[1]),
]);
export const annotationColorSchema = t.Union([
  t.Literal(ANNOTATION_COLOR_SCHEMA_VALUES[0]),
  t.Literal(ANNOTATION_COLOR_SCHEMA_VALUES[1]),
  t.Literal(ANNOTATION_COLOR_SCHEMA_VALUES[2]),
  t.Literal(ANNOTATION_COLOR_SCHEMA_VALUES[3]),
  t.Literal(ANNOTATION_COLOR_SCHEMA_VALUES[4]),
]);
export const annotationStyleSchema = t.Union([
  t.Literal(ANNOTATION_STYLE_SCHEMA_VALUES[0]),
  t.Literal(ANNOTATION_STYLE_SCHEMA_VALUES[1]),
  t.Literal(ANNOTATION_STYLE_SCHEMA_VALUES[2]),
  t.Literal(ANNOTATION_STYLE_SCHEMA_VALUES[3]),
]);
export const annotationVisibilitySchema = t.Union([
  t.Literal(ANNOTATION_VISIBILITY_SCHEMA_VALUES[0]),
  t.Literal(ANNOTATION_VISIBILITY_SCHEMA_VALUES[1]),
]);

/** The route schema has validated these values; preserve its closed domain. */
export const requireAnnotationTargetType = (
  value: string,
): ReaderAnnotationTargetType => {
  switch (value) {
    case "decision":
    case "statute":
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
  targetId: tUuid,
} as const;

/** Where on the document one paragraph's share of the annotation sits. */
const spanSchema = t.Object({
  blockAnchorId: t.String({ minLength: 1, maxLength: 64 }),
  startOffset: t.Integer({ minimum: 0 }),
  endOffset: t.Integer({ minimum: 1 }),
  quote: t.String({
    minLength: 1,
    maxLength: READER_ANNOTATION_QUOTE_MAX_LENGTH,
  }),
});

const spansSchema = t.Array(spanSchema, {
  minItems: 1,
  maxItems: READER_ANNOTATION_MAX_SPANS,
});

/**
 * One body per kind, so a highlight cannot carry words and a comment cannot
 * arrive without them; the database CHECK says the same.
 */
export const createAnnotationBodySchema = t.Union([
  t.Object({
    ...targetSchemaFields,
    kind: t.Literal("highlight"),
    color: annotationColorSchema,
    style: annotationStyleSchema,
    requestId: t.Optional(tSafeId("legalReaderAnnotation")),
    visibility: t.Optional(annotationVisibilitySchema),
    spans: spansSchema,
  }),
  t.Object({
    ...targetSchemaFields,
    kind: t.Literal("comment"),
    body: t.String({
      minLength: 1,
      maxLength: READER_ANNOTATION_BODY_MAX_LENGTH,
    }),
    requestId: t.Optional(tSafeId("legalReaderAnnotation")),
    visibility: t.Optional(annotationVisibilitySchema),
    spans: spansSchema,
  }),
]);

export type CreateAnnotationBody = Static<typeof createAnnotationBodySchema>;

/** One change per request, named, so an update cannot be empty or ambiguous. */
export const updateAnnotationBodySchema = t.Union([
  t.Object({
    change: t.Literal("body"),
    body: t.String({
      minLength: 1,
      maxLength: READER_ANNOTATION_BODY_MAX_LENGTH,
    }),
  }),
  t.Object({ change: t.Literal("color"), color: annotationColorSchema }),
  t.Object({ change: t.Literal("style"), style: annotationStyleSchema }),
  t.Object({
    change: t.Literal("visibility"),
    visibility: annotationVisibilitySchema,
  }),
]);

export type UpdateAnnotationBody = Static<typeof updateAnnotationBodySchema>;

export const annotationParamsSchema = t.Object({
  annotationId: tSafeId("legalReaderAnnotation"),
});
