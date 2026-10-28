import * as v from "valibot";

import {
  DECISION_REVIEW_LINK_LIMIT,
  decisionReviewLinkSchema,
  decisionReviewsSchema,
} from "@stll/api-contract/case-law-reviews";

import { passthroughId, projectionBranch } from "./projection-fields";

const link = v.strictObject({
  ...decisionReviewLinkSchema.entries,
  reviewingDecisionId: passthroughId(),
  reviewedDecisionId: v.nullable(passthroughId()),
});
const links = v.pipe(v.array(link), v.maxLength(DECISION_REVIEW_LINK_LIMIT));
const edges = { reviewedBy: links, reviews: links };

/** Derive the wire branches, annotating only public corpus handles for chat. */
export const DECISION_REVIEWS_PROJECTION = v.variant("status", [
  projectionBranch(
    v.strictObject({ ...decisionReviewsSchema.options[0].entries, ...edges }),
  ),
  projectionBranch(
    v.strictObject({ ...decisionReviewsSchema.options[1].entries, ...edges }),
  ),
]);
