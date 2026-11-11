import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { claimReviewEventSchema } from "@/api/handlers/lists/verifications/claim-reviews/create";
import {
  CLAIM_REVIEW_EVENT_KINDS,
  CLAIM_REVIEW_REASON_RULE,
  type ClaimReviewAction,
  type ClaimReviewEventKind,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";

/** One action of every kind, as a client sends it (status has no origin). */
const SENT = {
  status: { kind: "status", status: "needs-evidence" },
  override: { kind: "override", state: "contradicted" },
  note: { kind: "note", note: "Ask for the bank statement." },
  reopen: { kind: "reopen" },
  "record-conflict": {
    kind: "record-conflict",
    resolution: { kind: "escalated" },
  },
} as const satisfies {
  [Kind in ClaimReviewEventKind]: Omit<
    Extract<ClaimReviewAction, { kind: Kind }>,
    "origin"
  >;
};

const accepts = (event: object) =>
  v.safeParse(claimReviewEventSchema, event).success;

describe("review reasons in the request", () => {
  test.each(CLAIM_REVIEW_EVENT_KINDS)(
    "%s takes a reason as its rule says",
    (kind) => {
      const rule = CLAIM_REVIEW_REASON_RULE[kind];
      const event = SENT[kind];
      expect(accepts(event)).toBe(rule !== "required");
      expect(accepts({ ...event, reason: "The minutes say so." })).toBe(
        rule !== "none",
      );
      // Blank or oversized reasons are never a reason, whatever the rule.
      for (const reason of [
        "",
        "  \n\t ",
        "x".repeat(VERIFICATION_LIMITS.NOTE_MAX + 1),
      ]) {
        expect(accepts({ ...event, reason })).toBe(false);
      }
    },
  );

  test("a reason is stored trimmed", () => {
    const parsed = v.parse(claimReviewEventSchema, {
      ...SENT.override,
      reason: "  The diary hedges.\n",
    });
    expect(parsed).toEqual({ ...SENT.override, reason: "The diary hedges." });
  });
});
