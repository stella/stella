import { describe, expect, test } from "bun:test";

import {
  canRevertReviewSuggestion,
  getReviewBarAction,
  getReviewBarFocusTarget,
  getReviewBarPosition,
} from "./review-bar.logic";
import type { ReviewSuggestion, ReviewSuggestionStatus } from "./review-store";

const suggestion = (
  id: string,
  status: ReviewSuggestionStatus,
): ReviewSuggestion => ({
  applyMode: null,
  area: "Terms",
  blockId: `block-${id}`,
  id,
  origin: "chat",
  pendingOperation: null,
  preview: { anchor: id, type: "commentOnBlock" },
  revisionIds: null,
  severity: "medium",
  snapshot: null,
  status,
  summary: id,
  type: "commentOnBlock",
  undoHandle: null,
});

describe("review bar session progress", () => {
  test("counts and navigates the full review session around resolved suggestions", () => {
    const items = [
      suggestion("one", "accepted"),
      suggestion("two", "pending"),
      suggestion("three", "rejected"),
      suggestion("four", "pending"),
    ];

    expect(getReviewBarPosition(items, "one")).toEqual({
      activeIndex: 0,
      current: 1,
      total: 4,
    });
    expect(getReviewBarPosition(items, "two")).toEqual({
      activeIndex: 1,
      current: 2,
      total: 4,
    });
    expect(getReviewBarPosition(items, "three")).toEqual({
      activeIndex: 2,
      current: 3,
      total: 4,
    });
    expect(getReviewBarPosition(items, "four")).toEqual({
      activeIndex: 3,
      current: 4,
      total: 4,
    });
  });

  test("repairs a stale focus with the first pending suggestion", () => {
    const items = [
      suggestion("resolved", "accepted"),
      suggestion("first-pending", "pending"),
      suggestion("second-pending", "pending"),
    ];

    expect(getReviewBarFocusTarget(items, "missing")).toBe("first-pending");
    expect(getReviewBarFocusTarget(items, null)).toBe("first-pending");
    expect(getReviewBarFocusTarget(items, "second-pending")).toBeNull();
    expect(
      getReviewBarFocusTarget([suggestion("done", "accepted")], "missing"),
    ).toBe("done");
  });

  test("offers revert only when the terminal decision is locally reversible", () => {
    const hydratedAccepted = suggestion("accepted", "accepted");
    const liveAccepted = {
      ...hydratedAccepted,
      revisionIds: [7],
    };
    const rejected = suggestion("rejected", "rejected");
    const skipped = suggestion("skipped", "skipped");

    expect(canRevertReviewSuggestion(hydratedAccepted)).toBe(false);
    expect(getReviewBarAction(hydratedAccepted)).toBe("resolved");
    expect(canRevertReviewSuggestion(liveAccepted)).toBe(true);
    expect(getReviewBarAction(liveAccepted)).toBe("revert");
    expect(getReviewBarAction(rejected)).toBe("revert");
    expect(getReviewBarAction(skipped)).toBe("revert");
    expect(getReviewBarAction(suggestion("pending", "pending"))).toBe(
      "resolve",
    );
    expect(getReviewBarAction(suggestion("applying", "applying"))).toBe("busy");
  });
});
