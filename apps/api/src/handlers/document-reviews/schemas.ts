import { t } from "elysia";
import type { Static } from "elysia";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { tSafeId } from "@/api/lib/custom-schema";
import {
  REVIEW_PARTY_NAME_MAX_LENGTH,
  REVIEW_PARTY_ROLE_MAX_LENGTH,
} from "@/api/lib/document-review/contract";
import type { DocumentReviewTopic as ReviewEngineTopic } from "@/api/lib/document-review/contract";
import {
  DOCUMENT_REVIEW_APPLICATION_STATUS,
  DOCUMENT_REVIEW_DECISIONS,
} from "@/api/lib/document-review/run-contract";
import type { DocumentReviewDecision } from "@/api/lib/document-review/run-contract";

// The target always belongs to the route's matter, so it carries no workspace
// of its own; the handler stamps the route's onto it.
export const documentReviewTargetSchema = t.Object({
  entityId: tSafeId("entity"),
  fileFieldId: tSafeId("field"),
});

// A reference may live in another matter than the target (a signed precedent
// against a new draft), so it names its own workspace; the handler checks the
// caller can read that workspace before pinning anything from it.
export const documentReviewRefSchema = t.Object({
  workspaceId: tSafeId("workspace"),
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
  applicationStatus: t.Optional(
    t.Literal(DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED),
  ),
});

export type DocumentReviewDecisionInput = Assignable<
  Static<typeof decideReviewFindingBodySchema>["decision"],
  DocumentReviewDecision
>;

// The side a comparison is judged for: one of the target's parties by the
// role the document gives it, or no side. Required so a client cannot leave
// it out and get a side by default.
const reviewPerspectiveSchema = t.Union([
  t.Object({ type: t.Literal("neutral") }),
  t.Object({
    type: t.Literal("party"),
    role: t.String({ minLength: 1, maxLength: REVIEW_PARTY_ROLE_MAX_LENGTH }),
    name: t.Nullable(t.String({ maxLength: REVIEW_PARTY_NAME_MAX_LENGTH })),
  }),
]);

const reviewDocumentsSchema = {
  target: documentReviewTargetSchema,
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
  target: documentReviewTargetSchema,
  playbookId: t.Optional(tSafeId("playbookDefinition")),
  references: t.Array(documentReviewRefSchema, {
    maxItems: DOCUMENT_REVIEW_LIMITS.referencesMax,
  }),
  /** The side the reference comparison is judged for. Sent even for a
   *  playbook-only run, where it is recorded on nothing. */
  perspective: reviewPerspectiveSchema,
  topics: t.Array(documentReviewTopicSchema, {
    minItems: 1,
    maxItems: DOCUMENT_REVIEW_LIMITS.topicsMax,
  }),
  /**
   * Restated size estimate from a prior 428 `usage_confirmation_required`
   * answer; the run starts only when it covers the current estimate.
   */
  confirmedUnits: t.Optional(t.Integer({ minimum: 0 })),
});
