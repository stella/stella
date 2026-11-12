import { describe, expect, test } from "bun:test";

import type { ReviewDecision } from "@stll/api-contract/review-decision";

import {
  AVT_CLAIM_REVIEW_DECISION,
  CLAIM_REVIEW_EVENT_KINDS,
  CLAIM_REVIEW_REASON_RULE,
  type ClaimReviewAction,
  type ClaimReviewEventKind,
  type ClaimReviewStatus,
  reviewReasonOf,
  type StoredClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";

AVT_CLAIM_REVIEW_DECISION satisfies Record<
  ClaimReviewStatus,
  ReviewDecision | null
>;

test("claim review statuses translate to shared decisions", () => {
  expect(AVT_CLAIM_REVIEW_DECISION).toEqual({
    reviewed: "accepted",
    disputed: "rejected",
    "needs-evidence": null,
  });
});

/** One stored action of every kind, with no reason. */
const STORED = {
  status: { kind: "status", status: "needs-evidence", origin: "single" },
  override: { kind: "override", state: "contradicted" },
  note: { kind: "note", note: "Ask for the bank statement." },
  reopen: { kind: "reopen" },
  "record-conflict": {
    kind: "record-conflict",
    resolution: { kind: "escalated" },
  },
} as const satisfies {
  [Kind in ClaimReviewEventKind]: Extract<ClaimReviewAction, { kind: Kind }>;
};

describe("reviewReasonOf", () => {
  test.each(CLAIM_REVIEW_EVENT_KINDS)(
    "%s reads its reason, or says why there is none",
    (kind) => {
      const action: StoredClaimReviewEventPayload = STORED[kind];
      const rule = CLAIM_REVIEW_REASON_RULE[kind];
      // An action stored before reasons were required has none, which only
      // an action that requires one reports as missing.
      expect(reviewReasonOf(action)).toEqual(
        rule === "required" ? { type: "unrecorded" } : { type: "none" },
      );
      if (rule !== "none") {
        expect(reviewReasonOf({ ...action, reason: "Checked." })).toEqual({
          type: "given",
          text: "Checked.",
        });
      }
    },
  );
});
