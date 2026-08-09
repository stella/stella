import { t } from "elysia";
import type { Static } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const documentReviewRefSchema = t.Object({
  entityId: tSafeId("entity"),
  fileFieldId: tSafeId("field"),
});

export type DocumentReviewRef = Static<typeof documentReviewRefSchema>;

const reviewTopicBase = {
  topicId: t.String({ format: "uuid" }),
  title: t.String({ minLength: 1, maxLength: 256 }),
  context: t.String({ maxLength: 2000 }),
  included: t.Boolean(),
};

export const documentReviewTopicSchema = t.Union([
  t.Object({
    ...reviewTopicBase,
    type: t.Literal("playbook"),
    positionId: t.String({ format: "uuid" }),
  }),
  t.Object({
    ...reviewTopicBase,
    type: t.Literal("reference"),
  }),
  t.Object({
    ...reviewTopicBase,
    type: t.Literal("custom"),
  }),
]);

export type DocumentReviewTopic = Static<typeof documentReviewTopicSchema>;

const reviewDocumentsSchema = {
  target: documentReviewRefSchema,
  references: t.Array(documentReviewRefSchema, {
    minItems: 1,
    maxItems: LIMITS.documentReviewReferencesMax,
  }),
};

export const proposeReviewTopicsBodySchema = t.Object({
  ...reviewDocumentsSchema,
  seededTopics: t.Array(documentReviewTopicSchema, {
    maxItems: LIMITS.documentReviewTopicsMax,
  }),
});

export const compareReferencesBodySchema = t.Object({
  ...reviewDocumentsSchema,
  topics: t.Array(documentReviewTopicSchema, {
    minItems: 1,
    maxItems: LIMITS.documentReviewTopicsMax,
  }),
});
