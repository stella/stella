import * as v from "valibot";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  REVIEW_PARTY_NAME_MAX_LENGTH,
  REVIEW_PARTY_ROLE_MAX_LENGTH,
  REVIEW_SKIP_REASON_MAX_LENGTH,
  REVIEW_SKIP_SUBJECT_MAX_LENGTH,
  REVIEW_SKIPPED_MAX,
} from "@/api/lib/document-review/contract";
import {
  DOCUMENT_REVIEW_APPLICATION_STATUS,
  DOCUMENT_REVIEW_DECISIONS,
  DOCUMENT_REVIEW_FINDING_FLAGS,
  DOCUMENT_REVIEW_FINDING_FLAGS_MAX,
} from "@/api/lib/document-review/run-contract";
import type { DocumentReviewDecision } from "@/api/lib/document-review/run-contract";
import { positionSchema } from "@/api/lib/workflow/playbook-positions";

// The target always belongs to the route's matter, so it carries no workspace
// of its own; the handler stamps the route's onto it.
export const documentReviewTargetSchema = v.object({
  entityId: resourceIdSchema("entity"),
  fileFieldId: resourceIdSchema("field"),
});

// A reference may live in another matter than the target (a signed precedent
// against a new draft), so it names its own workspace; the handler checks the
// caller can read that workspace before pinning anything from it.
const documentReviewRefSchema = v.object({
  workspaceId: resourceIdSchema("workspace"),
  entityId: resourceIdSchema("entity"),
  fileFieldId: resourceIdSchema("field"),
});

export type DocumentReviewRef = v.InferOutput<typeof documentReviewRefSchema>;

// The decision vocabulary reaches the wire from the same const the column's
// CHECK constraint is derived from, so the schema cannot accept a value the
// database refuses.
export const decideReviewFindingBodySchema = v.object({
  decision: v.picklist([...DOCUMENT_REVIEW_DECISIONS]),
  applicationStatus: v.optional(
    v.literal(DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED),
  ),
  flags: v.optional(
    v.pipe(
      v.array(v.picklist([...DOCUMENT_REVIEW_FINDING_FLAGS])),
      v.maxLength(DOCUMENT_REVIEW_FINDING_FLAGS_MAX),
    ),
  ),
});

true satisfies v.InferOutput<
  typeof decideReviewFindingBodySchema
>["decision"] extends DocumentReviewDecision
  ? true
  : never;

// The side a comparison is judged for: one of the target's parties by the
// role the document gives it, or no side. Required so a client cannot leave
// it out and get a side by default.
const reviewPerspectiveSchema = v.union([
  v.object({ type: v.literal("neutral") }),
  v.object({
    type: v.literal("party"),
    role: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(REVIEW_PARTY_ROLE_MAX_LENGTH),
    ),
    name: v.nullable(
      v.pipe(v.string(), v.maxLength(REVIEW_PARTY_NAME_MAX_LENGTH)),
    ),
  }),
]);

/**
 * A subject the proposal pass read and deliberately did not compare.
 *
 * The reason is coded rather than English prose: the two the prompt itself
 * hands the model are decided by the normalizer and rendered in the reader's
 * own language, and only a reason the model wrote travels as text, in whatever
 * language the document is. The run inserts this value into a column typed
 * `ReviewSkippedTerm[]`, so a wire shape that drifts from the engine's fails
 * typecheck at that insert rather than at a reader.
 */
const reviewSkippedTermSchema = v.object({
  subject: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(REVIEW_SKIP_SUBJECT_MAX_LENGTH),
  ),
  reason: v.union([
    v.object({ kind: v.literal("deal-specific-value") }),
    v.object({ kind: v.literal("structural") }),
    v.object({ kind: v.literal("lower-weight") }),
    v.object({
      kind: v.literal("other"),
      text: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(REVIEW_SKIP_REASON_MAX_LENGTH),
      ),
    }),
  ]),
});

// The positions a request carries are exactly the positions a playbook holds:
// one schema, so a list confirmed for one run and a list saved as a playbook
// cannot diverge.
const reviewPositionsSchema = v.pipe(
  v.array(positionSchema),
  v.maxLength(DOCUMENT_REVIEW_LIMITS.positionsMax),
);

export const proposeReviewPositionsBodySchema = v.object({
  target: documentReviewTargetSchema,
  references: v.pipe(
    v.array(documentReviewRefSchema),
    v.minLength(1),
    v.maxLength(DOCUMENT_REVIEW_LIMITS.referencesMax),
  ),
  seededPositions: reviewPositionsSchema,
  perspective: reviewPerspectiveSchema,
});

/**
 * A run measures one document against a confirmed position list.
 *
 * `playbookId` names the playbook those positions came from, or is null when
 * they were proposed for this run alone and never saved: the run then pins an
 * ephemeral snapshot of exactly what is sent. `references` are the documents
 * any reference-standard position was derived from, pinned so the run stays
 * intelligible; they are read for provenance, not re-read at grading time.
 */
export const createDocumentReviewRunBodySchema = v.object({
  target: documentReviewTargetSchema,
  playbookId: v.nullable(resourceIdSchema("playbookDefinition")),
  positions: v.pipe(
    v.array(positionSchema),
    v.minLength(1),
    v.maxLength(DOCUMENT_REVIEW_LIMITS.positionsMax),
  ),
  references: v.pipe(
    v.array(documentReviewRefSchema),
    v.maxLength(DOCUMENT_REVIEW_LIMITS.referencesMax),
  ),
  perspective: reviewPerspectiveSchema,
  skipped: v.pipe(
    v.array(reviewSkippedTermSchema),
    v.maxLength(REVIEW_SKIPPED_MAX),
  ),
  confirmedUnits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
