import { expect, test } from "bun:test";

import { noDecisionReviewFound } from "@stll/api-contract/case-law-reviews";

import { projectionPayload } from "../projection-totality";
import { DECISION_REVIEWS_PROJECTION } from "./decision-review-projection";

test.each([
  { outcome: "upheld" as const, status: "upheld" as const },
  { outcome: "pending" as const, status: "under_review" as const },
])(
  "$outcome review evidence preserves public handles and qualifies missing links",
  ({ outcome, status }) => {
    const link = {
      reviewingDecisionId: "019dd78d-2e0c-7000-955a-63d713b246ba",
      reviewingCaseNumber: "7 As 32/2025-30",
      reviewingCourt: "Nejvyšší správní soud",
      reviewedDecisionId: "01a03050-4387-76b6-aae3-4b05db9a0238",
      reviewedCaseNumber: "25 A 20/2024-35",
      reviewedCourt: "Krajský soud v Ostravě",
      reviewedDecisionDate: "2025-01-16",
      outcome,
      source: "opening" as const,
      evidenceStatus: "opening_only" as const,
    };
    const evidence = {
      status,
      basis: "available_corpus" as const,
      reviewedBy: [link],
      reviews: [],
      reviewedByTruncated: false,
      reviewsTruncated: false,
    };
    expect(projectionPayload(DECISION_REVIEWS_PROJECTION, evidence)).toEqual(
      evidence,
    );
    expect(
      projectionPayload(DECISION_REVIEWS_PROJECTION, noDecisionReviewFound()),
    ).toMatchObject({
      status: "none_found",
      basis: "available_corpus",
      reason: "no_link_in_corpus",
    });
  },
);
