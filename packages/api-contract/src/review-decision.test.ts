import { describe, expect, test } from "bun:test";

import {
  AVT_CLAIM_REVIEW_DECISION,
  DOCUMENT_REVIEW_FINDING_DECISION,
  DOCX_SUGGESTION_REVIEW_DECISION,
  foldReviewDecisions,
  LIST_GENERATION_CANDIDATE_REVIEW_DECISION,
  LIST_ITEM_REVIEW_DECISION,
  LIST_ITEM_SOURCE_REVIEW_DECISION,
} from "./review-decision";

const event = (
  decision: "accepted" | "rejected" | null,
  at: string,
  actorId = "user-1",
) => ({ decision, reason: decision === null ? null : "because", actorId, at });

describe("foldReviewDecisions", () => {
  test("returns an open state for empty history", () => {
    expect(foldReviewDecisions([])).toEqual({
      decision: null,
      reason: null,
      decidedBy: null,
      decidedAt: null,
    });
  });

  test("orders events by time and lets the latest decision win", () => {
    expect(
      foldReviewDecisions([
        event("rejected", "2026-01-02T00:00:00Z"),
        event("accepted", "2026-01-01T00:00:00Z"),
      ]).decision,
    ).toBe("rejected");
  });

  test("reopens and can be decided again", () => {
    expect(
      foldReviewDecisions([
        event("accepted", "2026-01-01T00:00:00Z"),
        event(null, "2026-01-02T00:00:00Z"),
      ]).decision,
    ).toBeNull();
    expect(
      foldReviewDecisions([
        event("accepted", "2026-01-01T00:00:00Z"),
        event(null, "2026-01-02T00:00:00Z"),
        event("rejected", "2026-01-03T00:00:00Z", "user-2"),
      ]),
    ).toMatchObject({ decision: "rejected", decidedBy: "user-2" });
  });

  test("ties keep their given order", () => {
    const at = "2026-01-01T00:00:00Z";
    expect(
      foldReviewDecisions([event("accepted", at), event("rejected", at)])
        .decision,
    ).toBe("rejected");
  });
});

test("surface maps cover every vocabulary", () => {
  expect(Object.keys(AVT_CLAIM_REVIEW_DECISION)).toEqual([
    "reviewed",
    "disputed",
  ]);
  expect(Object.keys(DOCUMENT_REVIEW_FINDING_DECISION)).toEqual([
    "open",
    "accepted",
    "dismissed",
  ]);
  expect(Object.keys(LIST_ITEM_SOURCE_REVIEW_DECISION)).toEqual([
    "unverified",
    "verified",
    "rejected",
  ]);
  expect(Object.keys(LIST_ITEM_REVIEW_DECISION)).toEqual([
    "verified",
    "changes_requested",
    "rejected",
  ]);
  expect(Object.keys(DOCX_SUGGESTION_REVIEW_DECISION)).toEqual([
    "pending",
    "accepted",
    "rejected",
  ]);
  expect(Object.keys(LIST_GENERATION_CANDIDATE_REVIEW_DECISION)).toEqual([
    "pending",
    "accepting",
    "accepted",
    "rejected",
  ]);
});
