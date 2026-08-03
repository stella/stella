import { describe, expect, test } from "bun:test";

import { getReviewBarAction, getReviewBarPosition } from "./review-bar.logic";
import type { ReviewSuggestion, ReviewSuggestionStatus } from "./review-store";

const suggestion = (
  id: string,
  status: ReviewSuggestionStatus,
): ReviewSuggestion => ({
  applyMode: null,
  area: "Terms",
  blockId: `block-${id}`,
  id,
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
  test("keeps the original total and position after earlier decisions resolve", () => {
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
  });

  test("offers revert for every terminal decision", () => {
    expect(getReviewBarAction("accepted")).toBe("revert");
    expect(getReviewBarAction("rejected")).toBe("revert");
    expect(getReviewBarAction("skipped")).toBe("revert");
    expect(getReviewBarAction("pending")).toBe("resolve");
    expect(getReviewBarAction("applying")).toBe("busy");
  });
});
