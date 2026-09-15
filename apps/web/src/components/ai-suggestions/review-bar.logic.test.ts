import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  canRevertReviewChange,
  describeReviewChangeSummary,
  filterReviewChanges,
  getReviewBarAction,
  getReviewBarFocusTarget,
  getReviewBarPosition,
  groupReviewChanges,
  orderSuggestionsByDocumentPosition,
  reviewBarHeading,
  reviewChangeOf,
} from "./review-bar.logic";
import type { ReviewChange } from "./review-bar.logic";
import { REVIEW_UNSPECIFIED_AREA } from "./review-store";
import type { ReviewSuggestion, ReviewSuggestionStatus } from "./review-store";
import { folioOperationBlockId } from "./review-suggestion-builder";

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

const singles = (items: readonly ReviewSuggestion[]) =>
  items.map(reviewChangeOf);

describe("review bar session progress", () => {
  test("counts and navigates the full review session around resolved changes", () => {
    const changes = singles([
      suggestion("one", "accepted"),
      suggestion("two", "pending"),
      suggestion("three", "rejected"),
      suggestion("four", "pending"),
    ]);

    expect(getReviewBarPosition(changes, "one")).toEqual({
      activeIndex: 0,
      current: 1,
      total: 4,
    });
    expect(getReviewBarPosition(changes, "two")).toEqual({
      activeIndex: 1,
      current: 2,
      total: 4,
    });
    expect(getReviewBarPosition(changes, "three")).toEqual({
      activeIndex: 2,
      current: 3,
      total: 4,
    });
    expect(getReviewBarPosition(changes, "four")).toEqual({
      activeIndex: 3,
      current: 4,
      total: 4,
    });
  });

  test("repairs a stale focus with the first pending change", () => {
    const changes = singles([
      suggestion("resolved", "accepted"),
      suggestion("first-pending", "pending"),
      suggestion("second-pending", "pending"),
    ]);

    expect(getReviewBarFocusTarget(changes, "missing")).toBe("first-pending");
    expect(getReviewBarFocusTarget(changes, null)).toBe("first-pending");
    expect(getReviewBarFocusTarget(changes, "second-pending")).toBeNull();
    expect(
      getReviewBarFocusTarget(
        singles([suggestion("done", "accepted")]),
        "missing",
      ),
    ).toBe("done");
  });

  test("offers revert only when the terminal decision is locally reversible", () => {
    const hydratedAccepted = suggestion("accepted", "accepted");
    const liveAccepted = {
      ...hydratedAccepted,
      revisionIds: [7],
    };
    const rejected = reviewChangeOf(suggestion("rejected", "rejected"));
    const skipped = reviewChangeOf(suggestion("skipped", "skipped"));

    expect(canRevertReviewChange(reviewChangeOf(hydratedAccepted))).toBe(false);
    expect(getReviewBarAction(reviewChangeOf(hydratedAccepted))).toBe(
      "resolved",
    );
    expect(canRevertReviewChange(reviewChangeOf(liveAccepted))).toBe(true);
    expect(getReviewBarAction(reviewChangeOf(liveAccepted))).toBe("revert");
    expect(getReviewBarAction(rejected)).toBe("revert");
    expect(getReviewBarAction(skipped)).toBe("revert");
    expect(
      getReviewBarAction(reviewChangeOf(suggestion("pending", "pending"))),
    ).toBe("resolve");
    expect(
      getReviewBarAction(reviewChangeOf(suggestion("applying", "applying"))),
    ).toBe("busy");
  });
});

describe("what a review list shows", () => {
  const everyStatus = () =>
    singles([
      suggestion("s1", "pending"),
      suggestion("s2", "accepted"),
      suggestion("s3", "rejected"),
      suggestion("s4", "skipped"),
      suggestion("s5", "applying"),
    ]);

  test("shows every change while hideAccepted is off", () => {
    expect(
      filterReviewChanges(everyStatus(), { hideAccepted: false }),
    ).toHaveLength(5);
  });

  test("hideAccepted keeps pending and applying, drops the rest", () => {
    // The "applying" status must survive the filter so the loading
    // indicator doesn't disappear mid-Accept-click.
    const out = filterReviewChanges(everyStatus(), { hideAccepted: true });
    expect(out.map((change) => change.id)).toEqual(["s1", "s5"]);
  });
});

/** What one tool call saw; its suggestions share the reference. */
const PROPOSAL_SNAPSHOT = { anchors: {}, blocks: [] };
/** What a later tool call saw, after the document moved on. */
const LATER_PROPOSAL_SNAPSHOT = { anchors: {}, blocks: [] };

const onBlock = (
  id: string,
  blockId: string,
  overrides: Partial<ReviewSuggestion> = {},
): ReviewSuggestion => ({
  ...suggestion(id, "pending"),
  blockId,
  type: "deleteBlock",
  preview: { type: "deleteBlock", before: id },
  pendingOperation: {
    id: `op-${id}`,
    type: "deleteBlock",
    blockId,
  },
  snapshot: PROPOSAL_SNAPSHOT,
  ...overrides,
});

const replaceOnBlock = (id: string, blockId: string): ReviewSuggestion => ({
  ...suggestion(id, "pending"),
  blockId,
  type: "replaceInBlock",
  pendingOperation: {
    id: `op-${id}`,
    type: "replaceInBlock",
    blockId,
    find: "30 days",
    replace: "45 days",
  },
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

const memberIds = (changes: readonly ReviewChange[]) =>
  changes.map((change) => change.members.map((member) => member.id));

describe("a section deleted paragraph by paragraph is one change", () => {
  const section = [
    block("heading", "13"),
    block("body", "13.1"),
    block("next", "14"),
  ];

  test("a heading and its body deleted together are one change", () => {
    const changes = groupReviewChanges(
      [onBlock("heading", "heading"), onBlock("body", "body")],
      section,
    );

    expect(memberIds(changes)).toEqual([["heading", "body"]]);
    expect(changes.at(0)?.type).toBe("deletionRun");
    expect(changes.at(0)?.id).toBe("heading");
  });

  test("a deletion of a paragraph further down stays its own change", () => {
    const changes = groupReviewChanges(
      [onBlock("heading", "heading"), onBlock("next", "next")],
      section,
    );

    expect(memberIds(changes)).toEqual([["heading"], ["next"]]);
  });

  test("a replacement between two deletions splits them", () => {
    const changes = groupReviewChanges(
      [
        onBlock("heading", "heading"),
        replaceOnBlock("rename", "heading"),
        onBlock("body", "body"),
      ],
      section,
    );

    expect(memberIds(changes)).toEqual([["heading"], ["rename"], ["body"]]);
  });

  test("a review finding's fix never joins a neighbouring deletion", () => {
    const changes = groupReviewChanges(
      [
        onBlock("heading", "heading", { origin: "review" }),
        onBlock("body", "body"),
      ],
      section,
    );

    expect(memberIds(changes)).toEqual([["heading"], ["body"]]);
  });

  test("an accepted deletion does not join a pending one", () => {
    const changes = groupReviewChanges(
      [
        onBlock("heading", "heading", { status: "accepted" }),
        onBlock("body", "body"),
      ],
      section,
    );

    expect(memberIds(changes)).toEqual([["heading"], ["body"]]);
  });

  test("adjacent deletions proposed against different snapshots stay separate", () => {
    const changes = groupReviewChanges(
      [
        onBlock("heading", "heading"),
        onBlock("body", "body", { snapshot: LATER_PROPOSAL_SNAPSHOT }),
      ],
      section,
    );

    expect(memberIds(changes)).toEqual([["heading"], ["body"]]);
  });

  test("nothing groups while the document is unreadable", () => {
    const changes = groupReviewChanges(
      [onBlock("heading", "heading"), onBlock("body", "body")],
      [],
    );

    expect(memberIds(changes)).toEqual([["heading"], ["body"]]);
  });
});

describe("what a change says it does", () => {
  const section = [
    block("heading", "13"),
    block("body", "13.1"),
    block("plain"),
  ];

  test("names the first and last clause of a deletion run", () => {
    const [change] = groupReviewChanges(
      [
        onBlock("heading", "heading", { blockLabel: "13" }),
        onBlock("body", "body", { blockLabel: "13.1" }),
      ],
      section,
    );

    expect(change && describeReviewChangeSummary(change)).toEqual({
      type: "deleteParagraphRange",
      first: "13",
      last: "13.1",
    });
  });

  test("counts the paragraphs when an end of the run has no clause number", () => {
    const [change] = groupReviewChanges(
      [
        onBlock("body", "body", { blockLabel: "13.1" }),
        onBlock("plain", "plain"),
      ],
      section,
    );

    expect(change && describeReviewChangeSummary(change)).toEqual({
      type: "deleteParagraphs",
      count: 2,
    });
  });

  test("reads two deletions of one paragraph as that paragraph", () => {
    const [change] = groupReviewChanges(
      [
        onBlock("first", "body", { summary: "Delete paragraph 13.1" }),
        onBlock("again", "body", { summary: "Delete paragraph 13.1" }),
      ],
      section,
    );

    expect(change?.type).toBe("deletionRun");
    expect(change && describeReviewChangeSummary(change)).toEqual({
      type: "text",
      text: "Delete paragraph 13.1",
    });
  });
});

describe("what the bar says a decision is about", () => {
  test("names the issue a review finding raised", () => {
    expect(
      reviewBarHeading(
        reviewChangeOf({
          ...suggestion("one", "pending"),
          origin: "review",
          area: "Limitation of liability",
          summary: "Rewrite paragraph 8.2",
        }),
      ),
    ).toEqual({ type: "text", text: "Limitation of liability" });
  });

  test("says what the change does when the chat proposed it", () => {
    expect(
      reviewBarHeading(
        reviewChangeOf({
          ...suggestion("two", "pending"),
          origin: "chat",
          area: "Payment",
          summary: "Replace “30 days” with “45 days”",
        }),
      ),
    ).toEqual({ type: "text", text: "Replace “30 days” with “45 days”" });
  });

  test('never labels a decision "Unspecified"', () => {
    expect(
      reviewBarHeading(
        reviewChangeOf({
          ...suggestion("three", "pending"),
          origin: "review",
          area: REVIEW_UNSPECIFIED_AREA,
          summary: "Delete paragraph 4",
        }),
      ),
    ).toEqual({ type: "text", text: "Delete paragraph 4" });
    expect(
      reviewBarHeading(
        reviewChangeOf({
          ...suggestion("four", "pending"),
          origin: "review",
          area: "   ",
          summary: "Delete paragraph 4",
        }),
      ),
    ).toEqual({ type: "text", text: "Delete paragraph 4" });
  });
});

const STATUSES = [
  "pending",
  "applying",
  "accepted",
  "rejected",
  "skipped",
] as const satisfies readonly ReviewSuggestionStatus[];

const generatedSession = fc
  .integer({ min: 0, max: 8 })
  .chain((blockCount) =>
    fc.record({
      blocks: fc.constant(
        Array.from({ length: blockCount }, (_, index) => block(`b${index}`)),
      ),
      specs: fc.array(
        fc.record({
          // Past the end names a block the document does not know about.
          blockIndex: fc.integer({ min: 0, max: blockCount + 1 }),
          origin: fc.constantFrom("chat", "review"),
          kind: fc.constantFrom("delete", "replace"),
          status: fc.constantFrom(...STATUSES),
          snapshot: fc.constantFrom(
            PROPOSAL_SNAPSHOT,
            LATER_PROPOSAL_SNAPSHOT,
            null,
          ),
        }),
        { maxLength: 12 },
      ),
    }),
  )
  .map(({ blocks, specs }) => ({
    blocks,
    suggestions: specs.map((spec, index) => {
      const id = `s${index}`;
      const blockId = `b${spec.blockIndex}`;
      const base =
        spec.kind === "delete"
          ? onBlock(id, blockId)
          : replaceOnBlock(id, blockId);
      return {
        ...base,
        origin: spec.origin,
        status: spec.status,
        snapshot: spec.snapshot,
      };
    }),
  }));

const blockIndexOf = (
  member: ReviewSuggestion,
  blocks: readonly { id: string }[],
): number =>
  blocks.findIndex(
    (candidate) =>
      member.pendingOperation !== null &&
      candidate.id === folioOperationBlockId(member.pendingOperation),
  );

describe("grouping the review queue into changes", () => {
  test("partitions the queue without reordering it", () => {
    fc.assert(
      fc.property(generatedSession, ({ blocks, suggestions }) => {
        const ordered = orderSuggestionsByDocumentPosition(suggestions, blocks);
        const changes = groupReviewChanges(ordered, blocks);

        expect(changes.flatMap((change) => change.members)).toEqual([
          ...ordered,
        ]);
        for (const change of changes) {
          expect(change.id).toBe(change.members[0].id);
        }
      }),
      propertyConfig(),
    );
  });

  test("only chat deletions of adjacent blocks with one status share a change", () => {
    fc.assert(
      fc.property(generatedSession, ({ blocks, suggestions }) => {
        const changes = groupReviewChanges(
          orderSuggestionsByDocumentPosition(suggestions, blocks),
          blocks,
        );

        for (const change of changes) {
          expect(change.type).toBe(
            change.members.length === 1 ? "single" : "deletionRun",
          );
          if (change.type === "single") {
            continue;
          }
          const [first, ...rest] = change.members;
          let previousIndex = blockIndexOf(first, blocks);
          for (const member of change.members) {
            expect(member.origin).toBe("chat");
            expect(member.pendingOperation?.type).toBe("deleteBlock");
            expect(member.status).toBe(first.status);
            expect(member.snapshot).toBe(first.snapshot);
          }
          expect(first.snapshot).not.toBeNull();
          expect(previousIndex).toBeGreaterThanOrEqual(0);
          for (const member of rest) {
            const index = blockIndexOf(member, blocks);
            expect(index - previousIndex).toBeGreaterThanOrEqual(0);
            expect(index - previousIndex).toBeLessThanOrEqual(1);
            previousIndex = index;
          }
        }
      }),
      propertyConfig(),
    );
  });

  test("regrouping the grouped queue changes nothing", () => {
    fc.assert(
      fc.property(generatedSession, ({ blocks, suggestions }) => {
        const changes = groupReviewChanges(
          orderSuggestionsByDocumentPosition(suggestions, blocks),
          blocks,
        );
        const regrouped = groupReviewChanges(
          changes.flatMap((change) => change.members),
          blocks,
        );

        expect(regrouped).toEqual(changes);
      }),
      propertyConfig(),
    );
  });

  test("neighbouring changes could not have been one", () => {
    fc.assert(
      fc.property(generatedSession, ({ blocks, suggestions }) => {
        const changes = groupReviewChanges(
          orderSuggestionsByDocumentPosition(suggestions, blocks),
          blocks,
        );

        for (const [index, change] of changes.entries()) {
          const next = changes.at(index + 1);
          if (next === undefined) {
            continue;
          }
          const pair = groupReviewChanges(
            [change.members.at(-1) ?? change.members[0], next.members[0]],
            blocks,
          );
          expect(pair).toHaveLength(2);
        }
      }),
      propertyConfig(),
    );
  });
});
