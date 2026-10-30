import { expect, test } from "bun:test";

import type { ReviewDecision } from "@stll/api-contract/review-decision";

import {
  AVT_CLAIM_REVIEW_DECISION,
  type ClaimReviewStatus,
} from "@/api/lib/lists/verification/contract";

AVT_CLAIM_REVIEW_DECISION satisfies Record<
  ClaimReviewStatus,
  ReviewDecision | null
>;

test("claim review statuses translate to shared decisions", () => {
  expect(AVT_CLAIM_REVIEW_DECISION).toEqual({
    reviewed: "accepted",
    disputed: "rejected",
  });
});
