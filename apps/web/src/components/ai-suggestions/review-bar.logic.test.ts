import { describe, expect, test } from "bun:test";

import {
  canRevertReviewSuggestion,
  getReviewBarAction,
  getReviewBarFocusTarget,
  getReviewBarPosition,
  orderSuggestionsByDocumentPosition,
  reviewBarHeading,
} from "./review-bar.logic";
import { REVIEW_UNSPECIFIED_AREA } from "./review-store";
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

const onBlock = (
  id: string,
  blockId: string,
  overrides: Partial<ReviewSuggestion> = {},
): ReviewSuggestion => ({
  ...suggestion(id, "pending"),
  blockId,
  pendingOperation: {
    id: `op-${id}`,
    type: "deleteBlock",
    blockId,
  },
  ...overrides,
});

const block = (id: string, displayLabel?: string) =>
  displayLabel === undefined ? { id } : { id, displayLabel };

describe("review queue in document order", () => {
  test("steps through the document top to bottom, not in hydration order", () => {
    const ordered = orderSuggestionsByDocumentPosition(
      [onBlock("last", "c"), onBlock("first", "a"), onBlock("middle", "b")],
      [block("a"), block("b"), block("c")],
    );

    expect(ordered.map((item) => item.id)).toEqual(["first", "middle", "last"]);
  });

  test("keeps the store order for suggestions landing on one block", () => {
    const ordered = orderSuggestionsByDocumentPosition(
      [onBlock("second", "a"), onBlock("third", "a"), onBlock("outer", "b")],
      [block("a"), block("b")],
    );

    expect(ordered.map((item) => item.id)).toEqual([
      "second",
      "third",
      "outer",
    ]);
  });

  test("places a suggestion by its clause number when its block id is stale", () => {
    const stale = onBlock("stale", "gone", { blockLabel: "1.1" });
    const ordered = orderSuggestionsByDocumentPosition(
      [onBlock("later", "c"), stale],
      [block("a", "1.1"), block("c")],
    );

    expect(ordered.map((item) => item.id)).toEqual(["stale", "later"]);
  });

  test("sorts blocks the document does not know about last, in store order", () => {
    const ordered = orderSuggestionsByDocumentPosition(
      [
        onBlock("unknown-one", "x"),
        onBlock("known", "a"),
        onBlock("unknown-two", "y"),
      ],
      [block("a")],
    );

    expect(ordered.map((item) => item.id)).toEqual([
      "known",
      "unknown-one",
      "unknown-two",
    ]);
  });

  test("passes the session through while the editor is still unreadable", () => {
    const items = [onBlock("one", "c"), onBlock("two", "a")];

    expect(orderSuggestionsByDocumentPosition(items, [])).toBe(items);
  });

  test("falls back to the suggestion's own block once its operation is consumed", () => {
    const resolved = onBlock("resolved", "a", {
      pendingOperation: null,
      status: "accepted",
    });
    const ordered = orderSuggestionsByDocumentPosition(
      [onBlock("pending", "b"), resolved],
      [block("a"), block("b")],
    );

    expect(ordered.map((item) => item.id)).toEqual(["resolved", "pending"]);
  });
});

describe("what the bar says a decision is about", () => {
  test("names the issue a review finding raised", () => {
    expect(
      reviewBarHeading({
        ...suggestion("one", "pending"),
        origin: "review",
        area: "Limitation of liability",
        summary: "Rewrite paragraph 8.2",
      }),
    ).toBe("Limitation of liability");
  });

  test("says what the change does when the chat proposed it", () => {
    expect(
      reviewBarHeading({
        ...suggestion("two", "pending"),
        origin: "chat",
        area: "Payment",
        summary: "Replace “30 days” with “45 days”",
      }),
    ).toBe("Replace “30 days” with “45 days”");
  });

  test('never labels a decision "Unspecified"', () => {
    expect(
      reviewBarHeading({
        ...suggestion("three", "pending"),
        origin: "review",
        area: REVIEW_UNSPECIFIED_AREA,
        summary: "Delete paragraph 4",
      }),
    ).toBe("Delete paragraph 4");
    expect(
      reviewBarHeading({
        ...suggestion("four", "pending"),
        origin: "review",
        area: "   ",
        summary: "Delete paragraph 4",
      }),
    ).toBe("Delete paragraph 4");
  });
});
