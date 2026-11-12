import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { claimReviewEventSchema } from "@/api/handlers/lists/verifications/claim-reviews/create";
import { toSafeId } from "@/api/lib/branded-types";
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
  "fact-link": {
    kind: "fact-link",
    factEntityId: toSafeId<"entity">("11111111-1111-4111-8111-111111111111"),
    change: "link",
  },
} as const satisfies {
  [Kind in SentKind]: Omit<
    Extract<ClaimReviewAction, { kind: Kind }>,
    "origin"
  >;
};

/** A re-check is recorded by its own endpoint, which grades the claim. */
type SentKind = Exclude<ClaimReviewEventKind, "recheck">;
const SENT_KINDS = CLAIM_REVIEW_EVENT_KINDS.filter(
  (kind): kind is SentKind => kind !== "recheck",
);

const accepts = (event: object) =>
  v.safeParse(claimReviewEventSchema, event).success;

describe("review reasons in the request", () => {
  test("a re-check cannot be sent as a review action", () => {
    expect(
      accepts({
        kind: "recheck",
        requestKey: "key",
        grade: {
          state: "supported",
          score: 90,
          recordConflict: null,
          refs: [],
          qualifiers: [],
        },
        facts: { changed: [], removed: [] },
        modelRef: null,
      }),
    ).toBe(false);
  });

  test.each(SENT_KINDS)("%s takes a reason as its rule says", (kind) => {
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
  });

  test("a reason is stored trimmed", () => {
    const parsed = v.parse(claimReviewEventSchema, {
      ...SENT.override,
      reason: "  The diary hedges.\n",
    });
    expect(parsed).toEqual({ ...SENT.override, reason: "The diary hedges." });
  });
});
