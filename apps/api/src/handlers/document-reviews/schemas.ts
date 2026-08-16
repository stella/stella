import { t } from "elysia";
import type { Static } from "elysia";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { tSafeId } from "@/api/lib/custom-schema";
import type { DocumentReviewTopic as ReviewEngineTopic } from "@/api/lib/document-review/contract";
import { DOCUMENT_REVIEW_DECISIONS } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewDecision } from "@/api/lib/document-review/run-contract";

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

// The decision vocabulary reaches the wire from the same const the column's
// CHECK constraint is derived from, so the schema cannot accept a value the
// database refuses.
export const decideReviewFindingBodySchema = t.Object({
  decision: t.UnionEnum([...DOCUMENT_REVIEW_DECISIONS]),
});

export type DocumentReviewDecisionInput = Assignable<
  Static<typeof decideReviewFindingBodySchema>["decision"],
  DocumentReviewDecision
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

// A run's basis is a playbook, a set of references, or both, so `references`
// may be empty here where the topic proposal requires one. The handler rejects
// the empty basis with the reason, rather than the schema rejecting it as a
// shape error.
export const createDocumentReviewRunBodySchema = t.Object({
  target: documentReviewRefSchema,
  playbookId: t.Optional(tSafeId("playbookDefinition")),
  references: t.Array(documentReviewRefSchema, {
    maxItems: DOCUMENT_REVIEW_LIMITS.referencesMax,
  }),
  topics: t.Array(documentReviewTopicSchema, {
    minItems: 1,
    maxItems: DOCUMENT_REVIEW_LIMITS.topicsMax,
  }),
  /**
   * Restated size estimate from a prior 409 `usage_confirmation_required`
   * answer; the run starts only when it covers the current estimate.
   */
  confirmedUnits: t.Optional(t.Integer({ minimum: 0 })),
});
