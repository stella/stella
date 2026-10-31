import type { ReviewDecision } from "@stll/api-contract/review-decision";

import type {
  LegalListGenerationCandidateStatus,
  LegalListReviewDecision,
  LegalListSourceVerificationStatus,
} from "../../db/schema/lists";

export const LIST_ITEM_SOURCE_REVIEW_DECISION = {
  unverified: null,
  verified: "accepted",
  rejected: "rejected",
} as const satisfies Record<
  LegalListSourceVerificationStatus,
  ReviewDecision | null
>;

export const LIST_ITEM_REVIEW_DECISION = {
  verified: "accepted",
  changes_requested: "rejected",
  rejected: "rejected",
} as const satisfies Record<LegalListReviewDecision, ReviewDecision | null>;

export const LIST_GENERATION_CANDIDATE_REVIEW_DECISION = {
  pending: null,
  accepting: null,
  accepted: "accepted",
  rejected: "rejected",
} as const satisfies Record<
  LegalListGenerationCandidateStatus,
  ReviewDecision | null
>;
