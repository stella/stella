import { expect, test } from "bun:test";

import type { ReviewDecision } from "@stll/api-contract/review-decision";

import {
  LIST_GENERATION_CANDIDATE_REVIEW_DECISION,
  LIST_ITEM_REVIEW_DECISION,
  LIST_ITEM_SOURCE_REVIEW_DECISION,
} from "@/api/lib/lists/review-decision-maps";

import type {
  LegalListGenerationCandidateStatus,
  LegalListReviewDecision,
  LegalListSourceVerificationStatus,
} from "../../db/schema/lists";

LIST_ITEM_SOURCE_REVIEW_DECISION satisfies Record<
  LegalListSourceVerificationStatus,
  ReviewDecision | null
>;
LIST_ITEM_REVIEW_DECISION satisfies Record<
  LegalListReviewDecision,
  ReviewDecision | null
>;
LIST_GENERATION_CANDIDATE_REVIEW_DECISION satisfies Record<
  LegalListGenerationCandidateStatus,
  ReviewDecision | null
>;

test("source verification statuses translate to shared decisions", () => {
  expect(LIST_ITEM_SOURCE_REVIEW_DECISION).toEqual({
    unverified: null,
    verified: "accepted",
    rejected: "rejected",
  });
});

test("item review decisions translate to shared decisions", () => {
  expect(LIST_ITEM_REVIEW_DECISION).toEqual({
    verified: "accepted",
    changes_requested: "rejected",
    rejected: "rejected",
  });
});

test("candidate statuses translate to shared decisions", () => {
  expect(LIST_GENERATION_CANDIDATE_REVIEW_DECISION).toEqual({
    pending: null,
    accepting: null,
    accepted: "accepted",
    rejected: "rejected",
  });
});
