import { t } from "elysia";
import type { Static } from "elysia";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { tSafeId } from "@/api/lib/custom-schema";
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

type Assignable<Source extends Target, Target> = Source;

// The decision vocabulary reaches the wire from the same const the column's
// CHECK constraint is derived from, so the schema cannot accept a value the
// database refuses.
export const decideReviewFindingBodySchema = t.Object({
  decision: t.UnionEnum([...DOCUMENT_REVIEW_DECISIONS]),
  applicationStatus: t.Optional(
    t.Literal(DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED),
  ),
  /**
   * The finding's whole flag set, replacing whatever it held. Omitted leaves
   * the flags alone, which is what lets a decision and a flag be taken as two
   * separate gestures against one row.
   *
   * The same vocabulary as the column's CHECK and as the files table's cell
   * flags, from the one list all three derive from.
   */
  flags: t.Optional(
    t.Array(t.UnionEnum([...DOCUMENT_REVIEW_FINDING_FLAGS]), {
      maxItems: DOCUMENT_REVIEW_FINDING_FLAGS_MAX,
    }),
  ),
});

export type DocumentReviewDecisionInput = Assignable<
  Static<typeof decideReviewFindingBodySchema>["decision"],
  DocumentReviewDecision
>;

// The side a comparison is judged for: one of the target's parties by the
// role the document gives it, or no side. Required so a client cannot leave
// it out and get a side by default.
export const reviewPerspectiveSchema = t.Union([
  t.Object({ type: t.Literal("neutral") }),
  t.Object({
    type: t.Literal("party"),
    role: t.String({ minLength: 1, maxLength: REVIEW_PARTY_ROLE_MAX_LENGTH }),
    name: t.Nullable(t.String({ maxLength: REVIEW_PARTY_NAME_MAX_LENGTH })),
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
export const reviewSkippedTermSchema = t.Object({
  subject: t.String({
    minLength: 1,
    maxLength: REVIEW_SKIP_SUBJECT_MAX_LENGTH,
  }),
  reason: t.Union([
    t.Object({ kind: t.Literal("deal-specific-value") }),
    t.Object({ kind: t.Literal("structural") }),
    t.Object({ kind: t.Literal("lower-weight") }),
    t.Object({
      kind: t.Literal("other"),
      text: t.String({
        minLength: 1,
        maxLength: REVIEW_SKIP_REASON_MAX_LENGTH,
      }),
    }),
  ]),
});

// The positions a request carries are exactly the positions a playbook holds:
// one schema, so a list confirmed for one run and a list saved as a playbook
// cannot diverge.
const reviewPositionsSchema = t.Array(positionSchema, {
  maxItems: DOCUMENT_REVIEW_LIMITS.positionsMax,
});

export const proposeReviewPositionsBodySchema = t.Object({
  target: documentReviewTargetSchema,
  references: t.Array(documentReviewRefSchema, {
    minItems: 1,
    maxItems: DOCUMENT_REVIEW_LIMITS.referencesMax,
  }),
  /** Positions the reviewer already has (a playbook they picked); the proposal
   *  keeps them and does not repeat their issues. */
  seededPositions: reviewPositionsSchema,
  /**
   * The side the proposal is written for. An input, not an afterthought: what
   * a term is FOR and what a later comparison should examine both read
   * differently from each side of the same deal, and both are written into the
   * position here. The same schema the run sends, so the side confirmed with
   * the checklist is the side the run judges by.
   */
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
export const createDocumentReviewRunBodySchema = t.Object({
  target: documentReviewTargetSchema,
  playbookId: t.Nullable(tSafeId("playbookDefinition")),
  positions: t.Array(positionSchema, {
    minItems: 1,
    maxItems: DOCUMENT_REVIEW_LIMITS.positionsMax,
  }),
  references: t.Array(documentReviewRefSchema, {
    maxItems: DOCUMENT_REVIEW_LIMITS.referencesMax,
  }),
  /** The side the review is judged for. Sent even when no reference-derived
   *  position is in the list, where nothing reads it. */
  perspective: reviewPerspectiveSchema,
  /**
   * What the proposal pass read and left off the checklist, carried into the
   * run so the results can still say how much of the document was not
   * compared. Empty for a run with no proposal behind it — required, so that
   * is a client stating it rather than a field nobody remembered to send.
   */
  skipped: t.Array(reviewSkippedTermSchema, { maxItems: REVIEW_SKIPPED_MAX }),
  /**
   * Restated size estimate from a prior 428 `usage_confirmation_required`
   * answer; the run starts only when it covers the current estimate.
   */
  confirmedUnits: t.Optional(t.Integer({ minimum: 0 })),
});
