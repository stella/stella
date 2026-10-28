import * as v from "valibot";

/** Review edges are procedural history, independent of precedential citations. */
export const DECISION_REVIEW_OUTCOMES = [
  "upheld",
  "overturned",
  "partly",
  "unknown",
  "pending",
] as const;

export const DECISION_REVIEW_LINK_LIMIT = 32;
export const DECISION_REVIEW_SOURCES = [
  "metadata",
  "opening",
  "history",
] as const;
export const DECISION_REVIEW_EVIDENCE_STATUSES = [
  "consistent",
  "metadata_only",
  "opening_only",
  "conflict",
] as const;

const boundedText = (max: number) => v.pipe(v.string(), v.maxLength(max));

export const decisionReviewLinkSchema = v.strictObject({
  reviewingDecisionId: boundedText(36),
  reviewingCaseNumber: boundedText(1024),
  reviewingCourt: boundedText(2048),
  reviewedDecisionId: v.nullable(boundedText(36)),
  reviewedCaseNumber: boundedText(1024),
  reviewedCourt: boundedText(2048),
  reviewedDecisionDate: v.nullable(boundedText(32)),
  outcome: v.picklist(DECISION_REVIEW_OUTCOMES),
  source: v.picklist(DECISION_REVIEW_SOURCES),
  evidenceStatus: v.picklist(DECISION_REVIEW_EVIDENCE_STATUSES),
});

const reviewEvidence = {
  basis: v.literal("available_corpus"),
  reviewedBy: v.pipe(
    v.array(decisionReviewLinkSchema),
    v.maxLength(DECISION_REVIEW_LINK_LIMIT),
  ),
  reviews: v.pipe(
    v.array(decisionReviewLinkSchema),
    v.maxLength(DECISION_REVIEW_LINK_LIMIT),
  ),
  reviewedByTruncated: v.boolean(),
  reviewsTruncated: v.boolean(),
};

/** No link in the corpus is evidence of absence only within this corpus. */
export const decisionReviewsSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("none_found"),
    reason: v.literal("no_link_in_corpus"),
    ...reviewEvidence,
  }),
  v.strictObject({
    status: v.picklist([
      "upheld",
      "overturned",
      "partly",
      "under_review",
      "unknown",
    ]),
    ...reviewEvidence,
  }),
]);

export type DecisionReviewLink = v.InferOutput<typeof decisionReviewLinkSchema>;
export type DecisionReviews = v.InferOutput<typeof decisionReviewsSchema>;

/** Empty corpus evidence never asserts that no remedy was filed. */
export const noDecisionReviewFound = (): DecisionReviews => ({
  status: "none_found",
  basis: "available_corpus",
  reason: "no_link_in_corpus",
  reviewedBy: [],
  reviews: [],
  reviewedByTruncated: false,
  reviewsTruncated: false,
});
