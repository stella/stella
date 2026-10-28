import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  absorbedGroupIds,
  reviewItems,
} from "../src/activity/billing-draft-logic";
import type {
  DraftableGroup,
  DraftResult,
  ResolvedStructureProposal,
} from "../src/activity/billing-draft-logic";
import {
  initialReviewEdit,
  reviewReducer,
  reviewStateForGroups,
} from "../src/activity/billing-review-state";
import type { ReviewState } from "../src/activity/billing-review-state";

const classification = {
  type: "activity_group",
  activityGroup: "client",
} as const;
const makeGroup = (id: string): DraftableGroup => ({
  id,
  matter: {
    id,
    name: id,
    reference: null,
    color: null,
    clientName: null,
    signals: {
      lastWorkedAt: null,
      newlyAssignedAt: null,
      upcomingDeadline: null,
    },
  },
  confidence: "strong",
  evidence: [],
  apps: [],
  segments: [],
  durationMs: 3_600_000,
  roundedTenths: 10,
  ranges: [
    {
      start: new Date(
        Date.UTC(2026, 9, 24, 7 + ["first", "second", "third"].indexOf(id)),
      ).toISOString(),
      end: "2026-10-24T08:00:00Z",
    },
  ],
});
const groups = [makeGroup("first"), makeGroup("second")];
const currentGroups = new Map(groups.map((group) => [group.id, group]));
const initial = initialReviewEdit({
  type: "single",
  narrative: "My original",
  billable: true,
  classification: null,
});
const target = { groupId: "first", initial };
const sources = groups.map((group) => ({ group, initial }));
const entry = (state: ReviewState, id = "first") =>
  state.get(id) ?? panic("Missing review entry", id);
const rows = (state: ReviewState) =>
  groups.flatMap((group) => {
    const edit = state.get(group.id);
    return edit?.selected ? [{ group, content: edit.content }] : [];
  });
const result = (narrative: string): DraftResult => ({
  sentGroupIds: ["first", "second"],
  draft: {
    entryId: "entry_1",
    narrative,
    classification,
    flags: [],
    matchedEarlierEntryIds: [],
    operations: [],
  },
});
const split = {
  type: "split",
  summary: { type: "split", parts: 2 },
  parts: [
    {
      durationMinutes: 24,
      narrative: "First part",
      billable: true,
      classification,
    },
    {
      durationMinutes: 36,
      narrative: "Second part",
      billable: false,
      classification,
    },
  ],
} as const satisfies ResolvedStructureProposal;
const merge = {
  type: "merge",
  summary: { type: "merge", entries: 2 },
  groupIds: ["first", "second"],
  narrative: "Merged",
  billable: true,
  classification,
} satisfies ResolvedStructureProposal;
const move = {
  type: "move",
  summary: { type: "move", minutes: 24, matter: "Destination" },
  targetMatterId: "destination",
  targetMatterName: "Destination",
  targetMatter: {
    id: "destination",
    name: "Destination",
    reference: null,
    color: null,
  },
  durationMinutes: 24,
  narrative: "Moved",
  billable: true,
  classification,
} satisfies ResolvedStructureProposal;
const accept = (proposal: ResolvedStructureProposal) =>
  reviewReducer(new Map(), {
    type: "accept-structure",
    ...target,
    proposal,
    groups: sources,
  });

test("billing-review.materialized-item-edits", () => {
  assertProperty(
    "billing-review.materialized-item-edits",
    fc.property(
      fc.string({ maxLength: 80 }),
      fc.boolean(),
      (narrative, billable) => {
        for (const proposal of [split, merge, move]) {
          let state = accept(proposal);
          const before = reviewItems(rows(state), currentGroups);
          for (const item of before) {
            state = reviewReducer(state, {
              type: "set-narrative",
              ...target,
              itemKey: item.key,
              narrative,
            });
            state = reviewReducer(state, {
              type: "set-billable",
              ...target,
              itemKey: item.key,
              billable,
            });
          }
          const content = entry(state).content;
          if (content.type !== "accepted") {
            panic("Structure disappeared");
          }
          const submitted = reviewItems(rows(state), currentGroups);
          expect([...content.items]).toEqual(submitted);
          for (const [index, item] of submitted.entries()) {
            const stored =
              content.items.at(index) ?? panic("Stored item missing");
            const previous = before.at(index) ?? panic("Original item missing");
            expect(item).toBe(stored);
            expect(item.narrative).toBe(narrative);
            expect(item.billable).toBe(billable);
            expect(item.classification).toEqual(previous.classification);
            expect(item.ranges).toEqual(previous.ranges);
            expect(item.durationMinutes).toBe(previous.durationMinutes);
          }
        }
      },
    ),
  );
});

test("merge selection is atomic and preserves edited canonical items for reselect", () => {
  let state = accept(merge);
  state = reviewReducer(state, {
    type: "set-narrative",
    ...target,
    itemKey: "first",
    narrative: "Edited merge",
  });
  const edited = entry(state).content;
  const beforeRevision = entry(state).revision;
  state = reviewReducer(state, {
    type: "set-selected",
    groupId: "second",
    initial,
    selected: false,
  });
  expect([...state.values()].map((value) => value.selected)).toEqual([
    false,
    false,
  ]);
  expect(reviewItems(rows(state), currentGroups)).toEqual([]);
  expect(entry(state).content).toBe(edited);
  state = reviewReducer(state, {
    type: "set-selected",
    ...target,
    selected: true,
  });
  expect([...state.values()].map((value) => value.selected)).toEqual([
    true,
    true,
  ]);
  expect(
    reviewItems(rows(state), currentGroups).map((item) => item.narrative),
  ).toEqual(["Edited merge"]);
  expect(entry(state).revision).toBe(beforeRevision + 2);
  expect(entry(state, "second").revision).toBe(entry(state).revision);
  expect([...absorbedGroupIds(rows(state))]).toEqual(["second"]);
  state = reviewReducer(state, { type: "undo-structure", ...target });
  expect(entry(state).content).toEqual(initial.content);
  expect(entry(state, "second").content).toEqual(initial.content);
  expect(reviewItems(rows(state), currentGroups)).toHaveLength(2);
});

test("partial and overlapping structural acceptance is rejected", () => {
  const partial = new Map([["second", { ...initial, selected: false }]]);
  expect(
    reviewReducer(partial, {
      type: "accept-structure",
      ...target,
      proposal: merge,
      groups: sources,
    }),
  ).toBe(partial);
  const state = accept(split);
  expect(
    reviewReducer(state, {
      type: "accept-structure",
      ...target,
      proposal: merge,
      groups: sources,
    }),
  ).toBe(state);
  const merged = accept(merge);
  expect(
    reviewReducer(merged, {
      type: "accept-structure",
      groupId: "second",
      initial,
      proposal: split,
      groups: sources,
    }),
  ).toBe(merged);
});

test("late offers snapshot live edits only at the first actual application", () => {
  let state = reviewReducer(new Map(), {
    type: "set-narrative",
    ...target,
    itemKey: "first",
    narrative: "Typed during request",
  });
  const edited = entry(state).content;
  state = reviewReducer(state, {
    type: "offer-results",
    mode: "initial",
    offers: [{ ...target, expectedRevision: 0, result: result("AI one") }],
  });
  expect(entry(state).content).toBe(edited);
  expect(entry(state).draft?.using).toBe("proposal");
  state = reviewReducer(state, { type: "apply-proposal", ...target });
  state = reviewReducer(state, { type: "use-original", ...target });
  expect(entry(state).content).toEqual(edited);
  state = reviewReducer(state, {
    type: "set-narrative",
    ...target,
    itemKey: "first",
    narrative: "New undo baseline",
  });
  state = reviewReducer(state, { type: "use-draft", ...target });
  state = reviewReducer(state, { type: "use-original", ...target });
  expect(entry(state).content).toBe(edited);
});

test("unchanged offers apply atomically but accepted or absorbed groups only get proposals", () => {
  const offered = reviewReducer(new Map(), {
    type: "offer-results",
    mode: "initial",
    offers: [{ ...target, expectedRevision: 0, result: result("AI") }],
  });
  expect(entry(offered).draft?.using).toBe("draft");
  expect(entry(offered).content).toMatchObject({ narrative: "AI" });
  const accepted = accept(merge);
  const state = reviewReducer(accepted, {
    type: "offer-results",
    mode: "initial",
    offers: ["first", "second"].map((groupId) => ({
      groupId,
      initial,
      expectedRevision: entry(accepted, groupId).revision,
      result: result("Late"),
    })),
  });
  expect(entry(state).content).toBe(entry(accepted).content);
  expect(entry(state, "second").content).toBe(
    entry(accepted, "second").content,
  );
  expect(entry(state).draft?.using).toBe("proposal");
  expect(entry(state, "second").draft?.using).toBe("proposal");
});

test("undo all restores applied drafts and dismisses late proposals without touching edits", () => {
  let state = reviewReducer(new Map(), {
    type: "offer-results",
    mode: "initial",
    offers: [{ ...target, expectedRevision: 0, result: result("AI") }],
  });
  state = reviewReducer(state, {
    type: "set-narrative",
    groupId: "second",
    initial,
    itemKey: "second",
    narrative: "Keep my edits",
  });
  const preserved = entry(state, "second").content;
  state = reviewReducer(state, {
    type: "offer-results",
    mode: "steer",
    offers: [
      {
        groupId: "second",
        initial,
        expectedRevision: 0,
        result: result("Proposal"),
      },
    ],
  });
  state = reviewReducer(state, { type: "undo-all" });
  expect(entry(state).content).toEqual(initial.content);
  expect(entry(state, "second").content).toBe(preserved);
  expect([...state.values()].every((value) => value.draft === null)).toBe(true);
});

test("unknown canonical item keys panic rather than silently dropping edits", () => {
  for (const state of [new Map(), accept(split)]) {
    expect(() =>
      reviewReducer(state, {
        type: "set-narrative",
        ...target,
        itemKey: "missing",
        narrative: "Lost",
      }),
    ).toThrow("Unknown review item");
  }
});

test("scalar proposals never flatten accepted geometry or release its participants", () => {
  for (const proposal of [split, merge, move]) {
    let state = accept(proposal);
    const accepted = entry(state).content;
    state = reviewReducer(state, {
      type: "offer-results",
      mode: "steer",
      offers: [
        {
          ...target,
          expectedRevision: entry(state).revision,
          result: result("Scalar proposal"),
        },
      ],
    });
    expect(reviewReducer(state, { type: "apply-proposal", ...target })).toBe(
      state,
    );
    expect(reviewReducer(state, { type: "use-draft", ...target })).toBe(state);
    expect(entry(state).content).toBe(accepted);
    state = reviewReducer(state, { type: "undo-all" });
    expect(entry(state).content).toBe(accepted);
  }
  let merged = accept(merge);
  merged = reviewReducer(merged, {
    type: "offer-results",
    mode: "steer",
    offers: [
      {
        ...target,
        expectedRevision: entry(merged).revision,
        result: result("Scalar"),
      },
    ],
  });
  merged = reviewReducer(merged, { type: "apply-proposal", ...target });
  const third = makeGroup("third");
  const overlap = { ...merge, groupIds: ["second", "third"] };
  expect(
    reviewReducer(merged, {
      type: "accept-structure",
      groupId: "second",
      initial,
      proposal: overlap,
      groups: [...sources, { group: third, initial }],
    }),
  ).toBe(merged);
});

test.each(["use-original", "undo-all"] as const)(
  "%s after refinements restores the first pre-AI narrative and billable baseline",
  (undoType) => {
    let state = reviewReducer(new Map(), {
      type: "set-billable",
      ...target,
      itemKey: "first",
      billable: false,
    });
    const baseline = entry(state).content;
    state = reviewReducer(state, {
      type: "offer-results",
      mode: "initial",
      offers: [
        {
          ...target,
          expectedRevision: entry(state).revision,
          result: result("First AI draft"),
        },
      ],
    });
    const requestedRevision = entry(state).revision;
    state = reviewReducer(state, {
      type: "set-narrative",
      ...target,
      itemKey: "first",
      narrative: "Typed after steering request",
    });
    state = reviewReducer(state, {
      type: "set-billable",
      ...target,
      itemKey: "first",
      billable: true,
    });
    state = reviewReducer(state, {
      type: "offer-results",
      mode: "steer",
      offers: [
        {
          ...target,
          expectedRevision: requestedRevision,
          result: result("Steered proposal"),
        },
      ],
    });
    state = reviewReducer(state, { type: "apply-proposal", ...target });
    expect(entry(state).content).toMatchObject({
      narrative: "Steered proposal",
      billable: true,
    });
    state = reviewReducer(state, { type: undoType, ...target });
    expect(entry(state).content).toBe(baseline);
    expect(entry(state).content).toMatchObject({
      narrative: "My original",
      billable: false,
    });
  },
);

test("billing-review.changed-source-invalidates-acceptance", () => {
  assertProperty(
    "billing-review.changed-source-invalidates-acceptance",
    fc.property(
      fc.constantFrom("added", "reassigned", "shifted"),
      fc.integer({ min: 1, max: 5 }),
      (change, tenths) => {
        for (const proposal of [split, move, merge]) {
          const state = accept(proposal);
          const source = groups.at(0) ?? panic("Missing source group");
          const minutes = tenths * 6;
          const minute = minutes.toString().padStart(2, "0");
          const changed = {
            ...source,
            roundedTenths:
              source.roundedTenths +
              { added: tenths, reassigned: -tenths, shifted: 0 }[change],
            ranges: {
              added: [
                ...source.ranges,
                {
                  start: "2026-10-24T08:00:00Z",
                  end: `2026-10-24T08:${minute}:00Z`,
                },
              ],
              reassigned: [
                {
                  start: "2026-10-24T07:00:00.000Z",
                  end: `2026-10-24T07:${(60 - minutes).toString().padStart(2, "0")}:00Z`,
                },
              ],
              shifted: [
                {
                  start: `2026-10-24T07:${minute}:00Z`,
                  end: `2026-10-24T08:${minute}:00Z`,
                },
              ],
            }[change],
          };
          const live = new Map(currentGroups);
          live.set(source.id, changed);
          const liveRows = rows(state).map(({ group, content }) => ({
            group: live.get(group.id) ?? panic("Missing live source"),
            content,
          }));
          // Even a caller holding the old accepted state cannot submit stale ranges.
          expect(
            reviewItems(rows(state), live).flatMap((item) => item.ranges),
          ).toEqual(liveRows.flatMap(({ group }) => group.ranges));
          const refreshed = reviewStateForGroups(state, live);
          expect(entry(refreshed).content).toEqual({
            type: "single",
            narrative: "My original",
            billable: true,
            classification: null,
            notice: "sourceChanged",
          });
          expect(entry(refreshed).revision).toBeGreaterThan(
            entry(state).revision,
          );
          expect([...absorbedGroupIds(rows(refreshed))]).toEqual([]);
          expect(reviewStateForGroups(refreshed, live)).toBe(refreshed);
          expect(reviewStateForGroups(refreshed, currentGroups)).toBe(
            refreshed,
          );
        }
      },
    ),
  );
});

test("a changed merge participant releases the owner and an old split cannot omit new duration", () => {
  const changed = new Map(currentGroups);
  const second = groups.at(1) ?? panic("Missing merge participant");
  changed.set(second.id, {
    ...second,
    ranges: [{ start: "2026-10-24T08:00:00Z", end: "2026-10-24T09:00:00Z" }],
  });
  expect(entry(reviewStateForGroups(accept(merge), changed)).content.type).toBe(
    "single",
  );
  const first = groups.at(0) ?? panic("Missing split source");
  const extended = { ...first, roundedTenths: first.roundedTenths + 1 };
  const state = reviewReducer(new Map(), {
    type: "accept-structure",
    ...target,
    proposal: split,
    groups: [{ group: extended, initial }],
  });
  expect(state.size).toBe(0);
});
