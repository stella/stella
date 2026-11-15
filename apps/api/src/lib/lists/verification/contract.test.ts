import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  CLAIM_REVIEW_EVENT_KINDS,
  CLAIM_REVIEW_REASON_RULE,
  type ClaimReviewAction,
  type ClaimReviewEventKind,
  reviewReasonOf,
  type StoredClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";

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
  "fact-link": {
    kind: "fact-link",
    factEntityId: toSafeId<"entity">("11111111-1111-4111-8111-111111111111"),
    change: "link",
  },
  recheck: {
    kind: "recheck",
    requestKey: "key-1",
    grade: {
      state: "nocover",
      score: null,
      recordConflict: null,
      refs: [],
      qualifiers: [],
    },
    facts: { changed: [], removed: [] },
    modelRef: null,
  },
} satisfies {
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
