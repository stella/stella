import { describe, expect, test } from "bun:test";

import { foldReviewDecisions } from "./review-decision";

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

  test("orders by instant, not by how the time is written", () => {
    // The second time is written later but, once its offset is applied, it
    // happened first: the rejection is the later event.
    expect(
      foldReviewDecisions([
        event("rejected", "2026-01-01T09:00:00Z"),
        event("accepted", "2026-01-01T10:00:00+02:00"),
      ]).decision,
    ).toBe("rejected");
  });

  test("refuses an event time that is not an instant", () => {
    expect(() =>
      foldReviewDecisions([
        event("accepted", "2026-01-01T00:00:00Z"),
        event("rejected", "yesterday"),
      ]),
    ).toThrow(/not an instant/u);
  });

  test("refuses a single event whose time is not an instant", () => {
    expect(() => foldReviewDecisions([event("accepted", "yesterday")])).toThrow(
      /not an instant/u,
    );
  });

  test("ties keep their given order", () => {
    const at = "2026-01-01T00:00:00Z";
    expect(
      foldReviewDecisions([event("accepted", at), event("rejected", at)])
        .decision,
    ).toBe("rejected");
  });
});
