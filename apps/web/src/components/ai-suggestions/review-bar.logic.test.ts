import { describe, expect, test } from "bun:test";

import {
  canRevertReviewSuggestion,
  getReviewBarAction,
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
  test("keeps the active proposal at one while the remaining total shrinks", () => {
    const items = [
      suggestion("one", "accepted"),
      suggestion("two", "pending"),
      suggestion("three", "rejected"),
      suggestion("four", "pending"),
    ];

    expect(getReviewBarPosition(items, "one")).toEqual({
      activeIndex: 0,
      current: 1,
      total: 2,
    });
    expect(getReviewBarPosition(items, "two")).toEqual({
      activeIndex: 1,
      current: 1,
      total: 2,
    });
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
