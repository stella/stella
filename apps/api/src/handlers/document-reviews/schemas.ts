import { t } from "elysia";
import type { Static } from "elysia";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { tSafeId } from "@/api/lib/custom-schema";
import type { DocumentReviewTopic as ReviewEngineTopic } from "@/api/lib/document-review/contract";

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

type Assignable<Source extends Target, Target> = Source;

// Bind the wire union to the engine contract: if the request schema stops
// satisfying `ReviewEngineTopic`, this alias fails typecheck instead of the
// mismatch surfacing inside the engine.
export type DocumentReviewTopic = Assignable<
  Static<typeof documentReviewTopicSchema>,
  ReviewEngineTopic
>;

const reviewDocumentsSchema = {
  target: documentReviewRefSchema,
  references: t.Array(documentReviewRefSchema, {
    minItems: 1,
    maxItems: DOCUMENT_REVIEW_LIMITS.referencesMax,
  }),
};

export const proposeReviewTopicsBodySchema = t.Object({
  ...reviewDocumentsSchema,
  seededTopics: t.Array(documentReviewTopicSchema, {
    maxItems: DOCUMENT_REVIEW_LIMITS.topicsMax,
  }),
});

export const compareReferencesBodySchema = t.Object({
  ...reviewDocumentsSchema,
  topics: t.Array(documentReviewTopicSchema, {
    minItems: 1,
    maxItems: DOCUMENT_REVIEW_LIMITS.topicsMax,
  }),
});
