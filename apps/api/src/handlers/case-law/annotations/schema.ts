import { panic } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
  CASE_LAW_ANNOTATION_COLORS,
  CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH,
  CASE_LAW_ANNOTATION_STYLES,
  CASE_LAW_ANNOTATION_VISIBILITIES,
} from "@/api/db/schema";
import type {
  CaseLawAnnotationColor,
  CaseLawAnnotationStyle,
  CaseLawAnnotationVisibility,
} from "@/api/db/schema";
import { tSafeId } from "@/api/lib/custom-schema";

// The database tuples provide both the runtime enum and the static domain;
// `t.Unsafe` preserves that domain through Elysia's route contract, unlike a
// mapped `t.Union`, whose array element type widens to `never`.
export const annotationColorSchema = t.Unsafe<CaseLawAnnotationColor>({
  type: "string",
  enum: CASE_LAW_ANNOTATION_COLORS,
});
export const annotationStyleSchema = t.Unsafe<CaseLawAnnotationStyle>({
  type: "string",
  enum: CASE_LAW_ANNOTATION_STYLES,
});
export const annotationVisibilitySchema = t.Unsafe<CaseLawAnnotationVisibility>(
  {
    type: "string",
    enum: CASE_LAW_ANNOTATION_VISIBILITIES,
  },
);

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

/** A selection is a run of paragraphs; a court's reasoning rarely ends at one. */
export const ANNOTATION_MAX_SPANS = 40;

const spansSchema = t.Array(spanSchema, {
  minItems: 1,
  maxItems: ANNOTATION_MAX_SPANS,
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
    visibility: t.Optional(annotationVisibilitySchema),
    spans: spansSchema,
  }),
  t.Object({
    kind: t.Literal("comment"),
    body: t.String({
      minLength: 1,
      maxLength: CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
    }),
    visibility: t.Optional(annotationVisibilitySchema),
    spans: spansSchema,
  }),
]);

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
