import { panic } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
  CASE_LAW_ANNOTATION_COLORS,
  CASE_LAW_ANNOTATION_MAX_SPANS,
  CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH,
  CASE_LAW_ANNOTATION_STYLES,
  CASE_LAW_ANNOTATION_VISIBILITIES,
} from "@stll/api-contract/case-law-annotations";
import type {
  CaseLawAnnotationColor,
  CaseLawAnnotationStyle,
  CaseLawAnnotationVisibility,
} from "@stll/api-contract/case-law-annotations";

import { tSafeId } from "@/api/lib/custom-schema";

const ANNOTATION_COLOR_SCHEMA_VALUES = [
  CASE_LAW_ANNOTATION_COLORS[0],
  CASE_LAW_ANNOTATION_COLORS[1],
  CASE_LAW_ANNOTATION_COLORS[2],
  CASE_LAW_ANNOTATION_COLORS[3],
  CASE_LAW_ANNOTATION_COLORS[4],
] as const satisfies readonly CaseLawAnnotationColor[];
const ANNOTATION_STYLE_SCHEMA_VALUES = [
  CASE_LAW_ANNOTATION_STYLES[0],
  CASE_LAW_ANNOTATION_STYLES[1],
  CASE_LAW_ANNOTATION_STYLES[2],
  CASE_LAW_ANNOTATION_STYLES[3],
] as const satisfies readonly CaseLawAnnotationStyle[];
const ANNOTATION_VISIBILITY_SCHEMA_VALUES = [
  CASE_LAW_ANNOTATION_VISIBILITIES[0],
  CASE_LAW_ANNOTATION_VISIBILITIES[1],
] as const satisfies readonly CaseLawAnnotationVisibility[];

type MissingAnnotationColor = Exclude<
  CaseLawAnnotationColor,
  (typeof ANNOTATION_COLOR_SCHEMA_VALUES)[number]
>;
type MissingAnnotationStyle = Exclude<
  CaseLawAnnotationStyle,
  (typeof ANNOTATION_STYLE_SCHEMA_VALUES)[number]
>;
type MissingAnnotationVisibility = Exclude<
  CaseLawAnnotationVisibility,
  (typeof ANNOTATION_VISIBILITY_SCHEMA_VALUES)[number]
>;

true satisfies MissingAnnotationColor extends never ? true : never;
true satisfies MissingAnnotationStyle extends never ? true : never;
true satisfies MissingAnnotationVisibility extends never ? true : never;

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
export const requireAnnotationColor = (
  value: string,
): CaseLawAnnotationColor => {
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
): CaseLawAnnotationStyle => {
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
): CaseLawAnnotationVisibility => {
  switch (value) {
    case "private":
    case "shared":
      return value;
    default:
      return panic(`Invalid annotation visibility: ${value}`);
  }
};

/** Where on the decision one paragraph's share of the annotation sits. */
const spanSchema = t.Object({
  blockAnchorId: t.String({ minLength: 1, maxLength: 64 }),
  startOffset: t.Integer({ minimum: 0 }),
  endOffset: t.Integer({ minimum: 1 }),
  quote: t.String({
    minLength: 1,
    maxLength: CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH,
  }),
});

const spansSchema = t.Array(spanSchema, {
  minItems: 1,
  maxItems: CASE_LAW_ANNOTATION_MAX_SPANS,
});

/**
 * One body per kind, so a highlight cannot carry words and a comment cannot
 * arrive without them; the database CHECK says the same.
 */
export const createAnnotationBodySchema = t.Union([
  t.Object({
    kind: t.Literal("highlight"),
    color: annotationColorSchema,
    style: annotationStyleSchema,
    requestId: t.Optional(tSafeId("caseLawDecisionAnnotation")),
    visibility: t.Optional(annotationVisibilitySchema),
    spans: spansSchema,
  }),
  t.Object({
    kind: t.Literal("comment"),
    body: t.String({
      minLength: 1,
      maxLength: CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
    }),
    requestId: t.Optional(tSafeId("caseLawDecisionAnnotation")),
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
      maxLength: CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
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

export const decisionParamsSchema = t.Object({
  decisionId: tSafeId("caseLawDecision"),
});

export const annotationParamsSchema = t.Object({
  annotationId: tSafeId("caseLawDecisionAnnotation"),
});
