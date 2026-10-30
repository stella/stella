import { expect, test } from "bun:test";

import type { ReviewDecision } from "@stll/api-contract/review-decision";

import {
  DOCUMENT_REVIEW_FINDING_DECISION,
  type DocumentReviewDecision,
} from "@/api/lib/document-review/run-contract";

DOCUMENT_REVIEW_FINDING_DECISION satisfies Record<
  DocumentReviewDecision,
  ReviewDecision | null
>;

test("finding decisions translate to shared decisions", () => {
  expect(DOCUMENT_REVIEW_FINDING_DECISION).toEqual({
    open: null,
    accepted: "accepted",
    dismissed: "rejected",
  });
});
