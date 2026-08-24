import { t } from "elysia";
import type { Static } from "elysia";

import {
  CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
  CASE_LAW_ANNOTATION_COLORS,
  CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH,
  CASE_LAW_ANNOTATION_STYLES,
  CASE_LAW_ANNOTATION_VISIBILITIES,
} from "@/api/db/schema";
import { tSafeId } from "@/api/lib/custom-schema";

const tLiterals = <const T extends readonly string[]>(values: T) =>
  t.Union(values.map((value) => t.Literal(value)));

export const annotationColorSchema = tLiterals(CASE_LAW_ANNOTATION_COLORS);
export const annotationStyleSchema = tLiterals(CASE_LAW_ANNOTATION_STYLES);
export const annotationVisibilitySchema = tLiterals(
  CASE_LAW_ANNOTATION_VISIBILITIES,
);

/** Where on the decision the annotation sits. */
const anchorFields = {
  blockAnchorId: t.String({ minLength: 1, maxLength: 64 }),
  startOffset: t.Integer({ minimum: 0 }),
  endOffset: t.Integer({ minimum: 1 }),
  quote: t.String({
    minLength: 1,
    maxLength: CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH,
  }),
};

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
    ...anchorFields,
  }),
  t.Object({
    kind: t.Literal("comment"),
    body: t.String({
      minLength: 1,
      maxLength: CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
    }),
    visibility: t.Optional(annotationVisibilitySchema),
    ...anchorFields,
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
