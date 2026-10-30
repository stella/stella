import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  absorbedGroupIds,
  captureReviewSources,
  draftStructure,
  partitionRanges,
  resolveStructure,
  reviewItems,
} from "../src/activity/billing-draft-logic";
import type {
  DraftableGroup,
  DraftResult,
  ResolvedStructureProposal,
} from "../src/activity/billing-draft-logic";
import {
  canAcceptStructure,
  initialReviewEdit,
  reviewRecovery,
  reviewReducer,
  ReviewState,
  reviewStateForGroups,
} from "../src/activity/billing-review-state";
import type { ReviewAction } from "../src/activity/billing-review-state";

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
      end: new Date(
        Date.UTC(2026, 9, 24, 8 + ["first", "second", "third"].indexOf(id)),
      )
        .toISOString()
        .replace(".000Z", "Z"),
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
  sources: captureReviewSources(groups),
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
  reviewReducer(new ReviewState(), {
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
  const partial = new ReviewState([
    ["second", { ...initial, selected: false }],
  ]);
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
  let state = reviewReducer(new ReviewState(), {
    type: "set-narrative",
    ...target,
    itemKey: "first",
    narrative: "Typed during request",
  });
  const edited = entry(state).content;
  state = reviewReducer(state, {
    type: "offer-results",
    groups: currentGroups,
    mode: "initial",
    offers: [{ ...target, expectedRevision: 0, result: result("AI one") }],
  });
  expect(entry(state).content).toBe(edited);
  expect(entry(state).draft?.using).toBe("proposal");
  state = reviewReducer(state, {
    type: "apply-proposal",
    groups: currentGroups,
    ...target,
  });
  state = reviewReducer(state, { type: "use-original", ...target });
  expect(entry(state).content).toEqual(edited);
  state = reviewReducer(state, {
    type: "set-narrative",
    ...target,
    itemKey: "first",
    narrative: "New undo baseline",
  });
  state = reviewReducer(state, {
    type: "use-draft",
    groups: currentGroups,
    ...target,
  });
  state = reviewReducer(state, { type: "use-original", ...target });
  expect(entry(state).content).toBe(edited);
});

test("unchanged offers apply atomically but accepted or absorbed groups only get proposals", () => {
  const offered = reviewReducer(new ReviewState(), {
    type: "offer-results",
    groups: currentGroups,
    mode: "initial",
    offers: [{ ...target, expectedRevision: 0, result: result("AI") }],
  });
  expect(entry(offered).draft?.using).toBe("draft");
  expect(entry(offered).content).toMatchObject({ narrative: "AI" });
  const accepted = accept(merge);
  const state = reviewReducer(accepted, {
    type: "offer-results",
    groups: currentGroups,
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
  let state = reviewReducer(new ReviewState(), {
    type: "offer-results",
    groups: currentGroups,
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
    groups: currentGroups,
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
  for (const state of [new ReviewState(), accept(split)]) {
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
      groups: currentGroups,
      mode: "steer",
      offers: [
        {
          ...target,
          expectedRevision: entry(state).revision,
          result: result("Scalar proposal"),
        },
      ],
    });
    expect(
      reviewReducer(state, {
        type: "apply-proposal",
        groups: currentGroups,
        ...target,
      }),
    ).toBe(state);
    expect(
      reviewReducer(state, {
        type: "use-draft",
        groups: currentGroups,
        ...target,
      }),
    ).toBe(state);
    expect(entry(state).content).toBe(accepted);
    state = reviewReducer(state, { type: "undo-all" });
    expect(entry(state).content).toBe(accepted);
  }
  let merged = accept(merge);
  merged = reviewReducer(merged, {
    type: "offer-results",
    groups: currentGroups,
    mode: "steer",
    offers: [
      {
        ...target,
        expectedRevision: entry(merged).revision,
        result: result("Scalar"),
      },
    ],
  });
  merged = reviewReducer(merged, {
    type: "apply-proposal",
    groups: currentGroups,
    ...target,
  });
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
    let state = reviewReducer(new ReviewState(), {
      type: "set-billable",
      ...target,
      itemKey: "first",
      billable: false,
    });
    const baseline = entry(state).content;
    state = reviewReducer(state, {
      type: "offer-results",
      groups: currentGroups,
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
      groups: currentGroups,
      mode: "steer",
      offers: [
        {
          ...target,
          expectedRevision: requestedRevision,
          result: result("Steered proposal"),
        },
      ],
    });
    state = reviewReducer(state, {
      type: "apply-proposal",
      groups: currentGroups,
      ...target,
    });
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
          expect(
            entry(reviewStateForGroups(refreshed, currentGroups)).content,
          ).toBe(entry(refreshed).content);
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
  const state = reviewReducer(new ReviewState(), {
    type: "accept-structure",
    ...target,
    proposal: split,
    groups: [{ group: extended, initial }],
  });
  expect(state.size).toBe(0);
});

test("billing-review.offers-are-bound-to-requested-activity", () => {
  assertProperty(
    "billing-review.offers-are-bound-to-requested-activity",
    fc.property(
      fc.constantFrom("initial", "redraft", "steer"),
      fc.constantFrom("activity", "evidence", "context", "unchanged"),
      fc.string({ maxLength: 40 }),
      (mode, change, evidence) => {
        const previous = reviewReducer(new ReviewState(), {
          type: "offer-results",
          groups: currentGroups,
          mode: "initial",
          offers: [
            { ...target, expectedRevision: 0, result: result("Previous work") },
          ],
        });
        const state =
          mode === "initial"
            ? new ReviewState([[target.groupId, initial]])
            : previous;
        const current = entry(state);
        const offered = result("New suggestion");
        const live = new Map(currentGroups);
        const source =
          groups.at(change === "context" ? 1 : 0) ??
          panic("Missing activity source");
        if (change === "activity") {
          live.set(source.id, {
            ...source,
            roundedTenths: 11,
            durationMs: 3_960_000,
            ranges: [
              { start: "2026-10-24T07:00:00Z", end: "2026-10-24T08:06:00Z" },
            ],
          });
        }
        if (change === "evidence" || change === "context") {
          live.set(source.id, { ...source, evidence: [`Changed ${evidence}`] });
        }
        const expected = entry(reviewStateForGroups(state, live));
        const next = reviewReducer(state, {
          type: "offer-results",
          groups: live,
          mode: mode === "steer" ? "steer" : "initial",
          offers: [
            { ...target, expectedRevision: current.revision, result: offered },
          ],
        });
        const updated = entry(next);
        if (
          updated.content.type !== "single" ||
          current.content.type !== "single"
        ) {
          panic("Expected scalar review content");
        }
        const autoApplied = change === "unchanged" && mode !== "steer";
        if (autoApplied) {
          expect(updated.content.narrative).toBe("New suggestion");
          expect(updated.draft?.using).toBe("draft");
          return;
        }
        expect(updated.content.narrative).toBe(
          expected.content.type === "single"
            ? expected.content.narrative
            : panic("Expected scalar baseline"),
        );
        expect(updated.content.classification).toEqual(
          expected.content.type === "single"
            ? expected.content.classification
            : panic("Expected scalar baseline"),
        );
        expect(updated.revision).toBe(expected.revision);
        const pending = updated.draft;
        if (pending === null) {
          panic("Missing offered draft");
        }
        expect(
          pending.using === "proposal" ? pending.result : pending.proposal,
        ).toBe(offered);
        if (change !== "unchanged") {
          expect(updated.content).toMatchObject({ notice: "sourceChanged" });
        }
      },
    ),
  );
});

test("billing-review.applied-results-cannot-survive-source-edit-sequences", () => {
  assertProperty(
    "billing-review.applied-results-cannot-survive-source-edit-sequences",
    fc.property(
      fc.array(
        fc.record({
          manual: fc.constantFrom("none", "narrative", "billable", "both"),
          narrative: fc.string({ maxLength: 30 }),
          billable: fc.boolean(),
          selected: fc.boolean(),
          evidence: fc.string({ maxLength: 30 }),
        }),
        { minLength: 1, maxLength: 20 },
      ),
      (edits) => {
        for (const proposal of [null, split, merge, move]) {
          const live = new Map(currentGroups);
          let state = reviewReducer(new ReviewState(), {
            type: "offer-results",
            groups: live,
            mode: "initial",
            offers: [
              {
                ...target,
                expectedRevision: 0,
                result: result("AI narrative"),
              },
            ],
          });
          if (proposal !== null) {
            state = reviewReducer(state, {
              type: "accept-structure",
              ...target,
              proposal,
              groups: sources,
            });
          }
          let fallback = initial.content;
          for (const [index, edit] of edits.entries()) {
            const source =
              live.get(target.groupId) ?? panic("Missing live source");
            const before = reviewItems(
              [{ group: source, content: entry(state).content }],
              live,
            );
            const item = before.at(0) ?? panic("Missing review item");
            if (edit.manual === "narrative" || edit.manual === "both") {
              state = reviewReducer(state, {
                type: "set-narrative",
                ...target,
                itemKey: item.key,
                narrative: edit.narrative,
              });
            }
            if (edit.manual === "billable" || edit.manual === "both") {
              state = reviewReducer(state, {
                type: "set-billable",
                ...target,
                itemKey: item.key,
                billable: edit.billable,
              });
            }
            const edited = reviewItems(
              [{ group: source, content: entry(state).content }],
              live,
            );
            const userChanged = edited.some(
              (row, at) =>
                row.narrative !== before.at(at)?.narrative ||
                row.billable !== before.at(at)?.billable,
            );
            state = reviewReducer(state, {
              type: "set-selected",
              ...target,
              selected: edit.selected,
            });
            const changed = {
              ...source,
              durationMs: source.durationMs + 360_000,
              roundedTenths: source.roundedTenths + 1,
              evidence: [`${index}: ${edit.evidence}`],
            };
            expect(changed).not.toEqual(source);
            live.set(source.id, changed);
            const projected = reviewItems(
              [{ group: changed, content: entry(state).content }],
              live,
            );
            if (userChanged) {
              // Every user-entered scalar survives, including edits within a split, move or merge.
              expect(
                projected.map(
                  ({ narrative, billable, classification: codes }) => ({
                    narrative,
                    billable,
                    classification: codes,
                  }),
                ),
              ).toEqual(
                edited.map(
                  ({ narrative, billable, classification: codes }) => ({
                    narrative,
                    billable,
                    classification: codes,
                  }),
                ),
              );
            } else {
              expect(projected.at(0)).toMatchObject({
                narrative:
                  fallback.type === "single"
                    ? fallback.narrative
                    : panic("Expected scalar fallback"),
                billable: fallback.type === "single" ? fallback.billable : true,
                classification:
                  fallback.type === "single" ? fallback.classification : null,
              });
            }
            state = reviewStateForGroups(state, live);
            expect(entry(state).content.notice).toBe("sourceChanged");
            expect(
              reviewItems(
                [{ group: changed, content: entry(state).content }],
                live,
              ),
            ).toEqual(projected);
            expect(entry(state).draft?.using).toBe("proposal");
            const invalidated = state;
            expect(
              entry(reviewStateForGroups(state, currentGroups)).content,
            ).toBe(entry(invalidated).content);
            if (entry(state).content.type === "blocked") {
              expect(entry(state).content).toMatchObject({ ownership: "user" });
              // Discarding the edited structure is an explicit user action, never an invalidation.
              state = reviewReducer(state, {
                type: "undo-structure",
                ...target,
              });
              state = reviewStateForGroups(state, live);
            }
            fallback = entry(state).content;
            state = reviewReducer(state, {
              type: "apply-proposal",
              ...target,
              groups: live,
            });
            expect(entry(state).draft?.using).toBe("draft");
            expect(reviewStateForGroups(state, live)).toBe(state);
          }
        }
      },
    ),
  );
});

type ReviewModel = {
  state: ReviewState;
  groups: ReadonlyMap<string, DraftableGroup>;
};
const modelRows = ({ state, groups: live }: ReviewModel) =>
  [...live.values()].map((group) => ({
    group,
    edit: state.get(group.id) ?? initial,
  }));
const modelItems = (model: ReviewModel) =>
  reviewItems(
    modelRows(model)
      .filter(({ edit }) => edit.selected)
      .map(({ group, edit }) => ({ group, content: edit.content })),
    model.groups,
  );
const modelSubmittable = (model: ReviewModel) => {
  const selected = modelRows(model).filter(({ edit }) => edit.selected);
  return (
    selected.length > 0 &&
    selected.every(({ edit }) => edit.content.type !== "blocked") &&
    modelItems(model).every(({ narrative }) => narrative.trim().length > 0)
  );
};

const modelValues = ({ state, groups: live }: ReviewModel) => {
  const candidates = modelRows({ state, groups: live });
  const absorbed = absorbedGroupIds(
    candidates.map(({ group, edit }) => ({ group, content: edit.content })),
  );
  const active = candidates
    .filter(({ group }) => !absorbed.has(group.id))
    .map(({ edit }) => edit);
  const retained = [...state.retained.values()].map(({ edit }) => edit);
  return [...active, ...retained].flatMap(({ content }) =>
    content.type === "single"
      ? [
          JSON.stringify([
            content.narrative,
            content.billable,
            content.classification,
          ]),
        ]
      : content.items.map(({ narrative, billable, classification: codes }) =>
          JSON.stringify([narrative, billable, codes]),
        ),
  );
};

const assertReviewReferences = ({ state, groups: live }: ReviewModel) => {
  expect([...state.groups.keys()].toSorted()).toEqual(
    [...live.keys()].toSorted(),
  );
  const owners = new Map<string, string>();
  for (const [owner, edit] of state) {
    expect(live.has(owner)).toBe(true);
    if (edit.content.type === "single") {
      continue;
    }
    expect(edit.content.sources.map(({ id }) => id)).toContain(owner);
    for (const { id } of edit.content.sources) {
      expect(live.has(id)).toBe(true);
      expect(state.has(id)).toBe(true);
      expect(owners.get(id) ?? owner).toBe(owner);
      owners.set(id, owner);
    }
    expect(reviewRecovery(edit.content)?.type).toBe("undo-structure");
    for (const item of edit.content.items) {
      expect(item.key === owner || item.key.startsWith(`${owner}:`)).toBe(true);
    }
  }
  for (const id of state.retained.keys()) {
    expect(live.has(id)).toBe(false);
  }
  for (const { group, edit } of modelRows({ state, groups: live })) {
    if (owners.has(group.id) && owners.get(group.id) !== group.id) {
      continue;
    }
    const targetRow = { groupId: group.id, initial: edit };
    const controls: ReviewAction[] = [
      { type: "set-selected", ...targetRow, selected: !edit.selected },
      { type: "undo-all" },
    ];
    for (const item of reviewItems([{ group, content: edit.content }], live)) {
      controls.push(
        {
          type: "set-narrative",
          ...targetRow,
          itemKey: item.key,
          narrative: item.narrative,
        },
        {
          type: "set-billable",
          ...targetRow,
          itemKey: item.key,
          billable: !item.billable,
        },
      );
    }
    const recovery = reviewRecovery(edit.content);
    if (recovery !== null) {
      controls.push({ type: recovery.type, ...targetRow });
    }
    if (edit.draft?.using === "draft") {
      controls.push({ type: "use-original", ...targetRow });
    }
    if (edit.content.type === "single" && edit.draft !== null) {
      controls.push({ type: "apply-proposal", ...targetRow, groups: live });
    }
    for (const action of controls) {
      reviewStateForGroups(reviewReducer(state, action), live);
    }
  }
};

/** Exercise only controls the editable review exposes; every recovery comes from its content. */
const assertSubmissionReachable = (model: ReviewModel) => {
  assertReviewReferences(model);
  let next = model;
  for (let step = 0; step <= model.groups.size * 2 + 1; step += 1) {
    if (modelSubmittable(next)) {
      return;
    }
    const visibleRows = modelRows(next);
    const selected = visibleRows.filter(({ edit }) => edit.selected);
    let action: ReviewAction;
    if (selected.length === 0) {
      const row = visibleRows.at(0) ?? panic("Model needs a visible matter");
      action = {
        type: "set-selected",
        groupId: row.group.id,
        initial: row.edit,
        selected: true,
      };
    } else {
      const blocked = selected.find(
        ({ edit }) => edit.content.type === "blocked",
      );
      if (blocked) {
        const recovery = reviewRecovery(blocked.edit.content);
        if (recovery === null) {
          panic("Blocked content has no visible recovery");
        }
        action = {
          type: recovery.type,
          groupId: blocked.group.id,
          initial: blocked.edit,
        };
      } else {
        const absorbed = absorbedGroupIds(
          visibleRows.map(({ group, edit }) => ({
            group,
            content: edit.content,
          })),
        );
        const row =
          selected.find(
            ({ group, edit }) =>
              !absorbed.has(group.id) &&
              reviewItems(
                [{ group, content: edit.content }],
                model.groups,
              ).some(({ narrative }) => narrative.trim().length === 0),
          ) ?? panic("Unsubmittable review has no enabled visible action");
        const item =
          reviewItems(
            [{ group: row.group, content: row.edit.content }],
            next.groups,
          ).find(({ narrative }) => narrative.trim().length === 0) ??
          panic("Missing empty review field");
        action = {
          type: "set-narrative",
          groupId: row.group.id,
          initial: row.edit,
          itemKey: item.key,
          narrative: "Reviewed work",
        };
      }
    }
    const updated = reviewStateForGroups(
      reviewReducer(next.state, action),
      next.groups,
    );
    expect(updated).not.toBe(next.state);
    next = { state: updated, groups: next.groups };
  }
  expect(modelSubmittable(next)).toBe(true);
};

const RECORDING_MODEL_EVENTS = [
  "record",
  "disappear",
  "reassign",
  "regroup",
] as const;

type ModelGroupingChange = {
  type: "disappear" | "reassign" | "regroup";
  source: DraftableGroup;
  groups: Map<string, DraftableGroup>;
};
const changeModelGrouping = ({
  type,
  source,
  groups: live,
}: ModelGroupingChange) => {
  if (type === "disappear") {
    if (live.size > 1) {
      live.delete(source.id);
    }
  } else if (type === "reassign") {
    const recipient =
      [...live.values()].find(({ id }) => id !== source.id) ??
      makeGroup(source.id === "third" ? "fourth" : "third");
    const existing = live.has(recipient.id);
    live.delete(source.id);
    live.set(recipient.id, {
      ...recipient,
      durationMs: source.durationMs + (existing ? recipient.durationMs : 0),
      roundedTenths:
        source.roundedTenths + (existing ? recipient.roundedTenths : 0),
      ranges: [...(existing ? recipient.ranges : []), ...source.ranges],
    });
  } else {
    const id = ["first", "second", "third", "fourth"].find(
      (candidate) => !live.has(candidate),
    );
    if (id !== undefined) {
      const [kept, moved] = partitionRanges(source.ranges, [1, 1]);
      for (const [group, ranges] of [
        [source, kept],
        [makeGroup(id), moved],
      ] as const) {
        if (ranges === undefined) {
          panic("Regrouping lost a range partition");
        }
        const durationMs = ranges.reduce(
          (duration, range) =>
            duration + Date.parse(range.end) - Date.parse(range.start),
          0,
        );
        live.set(group.id, {
          ...group,
          durationMs,
          roundedTenths: Math.max(1, Math.ceil(durationMs / 360_000)),
          ranges,
        });
      }
    }
  }
};

type ModelRecordingChange = {
  state: ReviewState;
  groups: Map<string, DraftableGroup>;
  source: DraftableGroup;
  sequence: number;
};
const recordModelActivity = ({
  state,
  groups: live,
  source,
  sequence,
}: ModelRecordingChange) => {
  const userValues = modelRows({ state, groups: live })
    .filter(
      ({ edit }) =>
        edit.content.type === "blocked" ||
        (edit.content.type === "accepted"
          ? edit.content.ownership === "user"
          : edit.content.sourceBinding?.type === "user"),
    )
    .map(({ group, edit }) => ({
      group,
      values: reviewItems([{ group, content: edit.content }], live).map(
        ({ narrative, billable }) => ({
          narrative,
          billable,
        }),
      ),
    }));
  const end = source.ranges.at(-1)?.end ?? panic("Missing recorded range");
  live.set(source.id, {
    ...source,
    evidence: [`Recording ${sequence}`],
    roundedTenths: source.roundedTenths + 1,
    durationMs: source.durationMs + 360_000,
    ranges: [
      ...source.ranges,
      {
        start: end,
        end: new Date(Date.parse(end) + 360_000).toISOString(),
      },
    ],
  });
  const next = reviewStateForGroups(state, live);
  for (const { group, values } of userValues) {
    const edit = next.get(group.id) ?? initial;
    expect(
      reviewItems([{ group, content: edit.content }], live).map(
        ({ narrative, billable }) => ({ narrative, billable }),
      ),
    ).toEqual(values);
  }
  return next;
};

test("billing-review.visible-actions-always-reach-submission", () => {
  assertProperty(
    "billing-review.visible-actions-always-reach-submission",
    fc.property(
      fc.array(
        fc.record({
          type: fc.constantFrom(
            "draft",
            "steer",
            "accept",
            "review",
            "narrative",
            "billable",
            ...RECORDING_MODEL_EVENTS,
            "undo",
            "undo-all",
            "dismiss",
            "select",
          ),
          structure: fc.constantFrom("split", "merge", "move"),
          text: fc.string({ maxLength: 25 }),
          checked: fc.boolean(),
          group: fc.nat(1),
        }),
        { minLength: 1, maxLength: 60 },
      ),
      (events) => {
        for (const scenario of ["split", "merge", "move"] as const) {
          const prefix = (
            [
              "draft",
              "accept",
              "narrative",
              "record",
              "undo-all",
              "reassign",
              "regroup",
            ] as const
          ).map((type) => ({
            type,
            structure: scenario,
            text:
              type === "narrative" ? "User corrected text" : "AI suggestion",
            checked: true,
            group: 0,
          }));
          const live = new Map(currentGroups);
          let state = reviewStateForGroups(new ReviewState(), live);
          let entered = new Set<string>();
          for (const group of live.values()) {
            expect(
              group.ranges.reduce(
                (duration, range) =>
                  duration + Date.parse(range.end) - Date.parse(range.start),
                0,
              ),
            ).toBe(group.durationMs);
          }
          assertSubmissionReachable({ state, groups: live });
          for (const [index, event] of [...prefix, ...events].entries()) {
            const visibleRows = modelRows({ state, groups: live });
            const absorbed = absorbedGroupIds(
              visibleRows.map(({ group, edit }) => ({
                group,
                content: edit.content,
              })),
            );
            const visible = visibleRows.filter(
              ({ group }) => !absorbed.has(group.id),
            );
            const row =
              visible.at(event.group % visible.length) ??
              panic("Missing visible review owner");
            const targetRow = { groupId: row.group.id, initial: row.edit };
            let action: ReviewAction | null = null;
            switch (event.type) {
              case "draft":
              case "steer": {
                const steer = event.type === "steer";
                const requested = visibleRows.filter(
                  ({ edit, group }) =>
                    edit.selected &&
                    edit.content.type === "single" &&
                    !absorbed.has(group.id) &&
                    (steer
                      ? edit.draft?.using === "draft"
                      : edit.draft === null ||
                        edit.content.notice === "sourceChanged"),
                );
                if (requested.length === 0) {
                  break;
                }
                const source =
                  requested.at(0) ?? panic("Missing requested source");
                const proposal = (() => {
                  switch (event.structure) {
                    case "split":
                      return {
                        type: "split" as const,
                        parts: [
                          {
                            durationMinutes: 6,
                            narrative: "First",
                            billable: true,
                            classification,
                          },
                          {
                            durationMinutes: source.group.roundedTenths * 6 - 6,
                            narrative: "Rest",
                            billable: false,
                            classification,
                          },
                        ],
                      };
                    case "move":
                      return {
                        type: "move" as const,
                        targetMatterId: "destination",
                        targetMatterName: "Destination",
                        durationMinutes: 6,
                        narrative: "Moved",
                        billable: true,
                        classification,
                      };
                    case "merge":
                      return {
                        type: "merge" as const,
                        entryIds: requested.map((_, at) => `entry_${at + 1}`),
                        narrative: "Combined",
                        billable: true,
                        classification,
                      };
                    default:
                      return panic(
                        "Unknown model structure",
                        event.structure satisfies never,
                      );
                  }
                })();
                action = {
                  type: "offer-results",
                  groups: live,
                  mode: steer ? "steer" : "initial",
                  offers: requested.map(({ group, edit }, at) => ({
                    groupId: group.id,
                    initial: edit,
                    expectedRevision: edit.revision,
                    result: {
                      sources: captureReviewSources(
                        requested.map(({ group: sourceGroup }) => sourceGroup),
                      ),
                      draft: {
                        ...result(event.text).draft,
                        entryId: `entry_${at + 1}`,
                        operations:
                          at === 0 &&
                          (proposal.type !== "merge" || requested.length > 1)
                            ? [proposal]
                            : [],
                      },
                    },
                  })),
                };
                break;
              }
              case "accept": {
                if (row.edit.draft === null) {
                  break;
                }
                const structure = draftStructure(row.edit.draft.result.draft);
                if (structure === null) {
                  break;
                }
                const proposal = resolveStructure({
                  structure,
                  groupIds: row.edit.draft.result.sources.map(({ id }) => id),
                  candidates: [...live.values(), makeGroup("destination")].map(
                    ({ matter }) => matter,
                  ),
                });
                if (proposal === null) {
                  break;
                }
                const acceptance = {
                  type: "accept-structure",
                  ...targetRow,
                  proposal,
                  groups: visibleRows.map(({ group, edit }) => ({
                    group,
                    initial: edit,
                  })),
                } as const satisfies ReviewAction;
                if (canAcceptStructure(state, acceptance)) {
                  action = acceptance;
                }
                break;
              }
              case "review":
                if (
                  row.edit.content.type === "single" &&
                  row.edit.draft !== null
                ) {
                  if (
                    row.edit.draft.using === "proposal" ||
                    row.edit.draft.proposal !== null
                  ) {
                    action = {
                      type: "apply-proposal",
                      ...targetRow,
                      groups: live,
                    };
                  } else if (row.edit.draft.using === "original") {
                    action = { type: "use-draft", ...targetRow, groups: live };
                  }
                }
                break;
              case "narrative":
              case "billable": {
                const item =
                  reviewItems(
                    [{ group: row.group, content: row.edit.content }],
                    live,
                  ).at(0) ?? panic("Missing editable item");
                action =
                  event.type === "narrative"
                    ? {
                        type: "set-narrative",
                        ...targetRow,
                        itemKey: item.key,
                        narrative: event.text,
                      }
                    : {
                        type: "set-billable",
                        ...targetRow,
                        itemKey: item.key,
                        billable: event.checked,
                      };
                break;
              }
              case "record":
                state = recordModelActivity({
                  state,
                  groups: live,
                  source: row.group,
                  sequence: index,
                });
                break;
              case "disappear":
              case "reassign":
              case "regroup": {
                const before = [...entered];
                const source = row.group;
                changeModelGrouping({ type: event.type, source, groups: live });
                state = reviewStateForGroups(state, live);
                const after = modelValues({ state, groups: live });
                for (const value of before) {
                  expect(after).toContain(value);
                }
                break;
              }
              case "undo": {
                const recovery = reviewRecovery(row.edit.content);
                if (recovery !== null) {
                  action = { type: recovery.type, ...targetRow };
                } else if (row.edit.draft?.using === "draft") {
                  action = { type: "use-original", ...targetRow };
                }
                break;
              }
              case "undo-all":
                if (visibleRows.some(({ edit }) => edit.draft !== null)) {
                  action = { type: "undo-all" };
                }
                break;
              case "dismiss":
                if (
                  row.edit.draft?.using === "proposal" ||
                  (row.edit.draft !== null && row.edit.draft.proposal !== null)
                ) {
                  action = { type: "dismiss-proposal", ...targetRow };
                }
                break;
              case "select":
                action = {
                  type: "set-selected",
                  ...targetRow,
                  selected: event.checked,
                };
                break;
              default:
                event.type satisfies never;
            }
            if (action !== null) {
              state = reviewStateForGroups(reviewReducer(state, action), live);
            }
            if (event.type === "narrative" || event.type === "billable") {
              const edit = state.get(row.group.id) ?? initial;
              const item =
                reviewItems(
                  [{ group: row.group, content: edit.content }],
                  live,
                ).at(0) ?? panic("Manual input lost its visible row");
              entered.add(
                JSON.stringify([
                  item.narrative,
                  item.billable,
                  item.classification,
                ]),
              );
            }
            if (!RECORDING_MODEL_EVENTS.some((type) => type === event.type)) {
              const retainedValues = new Set(
                modelValues({ state, groups: live }),
              );
              // Only explicit user actions may replace a previously entered value.
              entered = new Set(
                [...entered].filter((value) => retainedValues.has(value)),
              );
            }
            if (index === 4) {
              expect(entry(state).content.type).toBe("blocked");
              expect(entry(state).draft).toBeNull();
            }
            assertSubmissionReachable({ state, groups: live });
          }
        }
      },
    ),
  );
});
