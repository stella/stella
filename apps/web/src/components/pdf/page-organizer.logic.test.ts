import { describe, expect, test } from "bun:test";

import type { CleanScanPageReview } from "@stll/scan-engine/review";

import type { CleanScanGeometry } from "@/lib/pdf/page-editor/clean-scan-run";

import {
  createPageOrganizerState,
  DEFAULT_CLEAN_SCAN_OPTIONS,
  getPageMoveDestination,
  isPageOrganizerDirty,
  type OrganizerPage,
  type PageOrganizerState,
  reducePageOrganizer,
  transformPagePlanEntries,
} from "./page-organizer.logic";

const pages = (count: number): OrganizerPage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `page-${index + 1}`,
    sourceId: "source-a",
    sourcePageIndex: index,
    rotation: 0 as const,
  }));

const stateWith = (count = 4): PageOrganizerState =>
  createPageOrganizerState({ pages: pages(count) });

const ids = (state: PageOrganizerState) =>
  state.history.present.pages.map((page) => page.id);

const expectInvariant = (state: PageOrganizerState) => {
  const plan = state.history.present;
  const pageIds = plan.pages.map((page) => page.id);
  expect(new Set(pageIds).size).toBe(pageIds.length);
  expect(state.ui.selectedPageIds.every((id) => pageIds.includes(id))).toBe(
    true,
  );
};

describe("page organizer state transitions", () => {
  test("rejects an empty document before creating editable state", () => {
    expect(() => createPageOrganizerState({ pages: [] })).toThrow(
      "A PDF page organizer requires at least one page",
    );
  });

  test("preserves invariants and range selection follows the current order", () => {
    let state = stateWith();
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-2"],
    });
    state = reducePageOrganizer(state, {
      type: "moveSelected",
      targetPageId: "page-4",
      edge: "before",
    });
    state = reducePageOrganizer(state, {
      type: "selectRange",
      pageId: "page-3",
    });

    expect(ids(state)).toEqual(["page-1", "page-3", "page-2", "page-4"]);
    expect(state.ui.selectedPageIds).toEqual(["page-3", "page-2"]);
    expectInvariant(state);
  });

  test("moves after a target through the final insertion point", () => {
    let state = stateWith();
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-1"],
    });
    state = reducePageOrganizer(state, {
      type: "moveSelected",
      targetPageId: "page-4",
      edge: "after",
    });

    expect(ids(state)).toEqual(["page-2", "page-3", "page-4", "page-1"]);
    expectInvariant(state);
  });

  test("reports the exact destination after removing the dragged selection", () => {
    expect(
      getPageMoveDestination({
        draggedPageId: "page-1",
        edge: "before",
        pages: pages(5),
        selectedPageIds: ["page-1", "page-2"],
        targetPageId: "page-5",
      }),
    ).toBe(3);
    expect(
      getPageMoveDestination({
        draggedPageId: "page-1",
        edge: "after",
        pages: pages(5),
        selectedPageIds: ["page-1", "page-2"],
        targetPageId: "page-5",
      }),
    ).toBe(4);
  });

  test("moves a multi-page selection one step without changing its internal order", () => {
    let state = stateWith();
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-2", "page-3"],
    });
    state = reducePageOrganizer(state, {
      type: "moveSelectedStep",
      direction: "forward",
    });
    expect(ids(state)).toEqual(["page-1", "page-4", "page-2", "page-3"]);
    state = reducePageOrganizer(state, {
      type: "moveSelectedStep",
      direction: "backward",
    });
    expect(ids(state)).toEqual(["page-1", "page-2", "page-3", "page-4"]);
    expectInvariant(state);
  });

  test("duplicates selected pages with caller-provided stable ids and preserves order", () => {
    let state = stateWith();
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-2", "page-3"],
    });
    state = reducePageOrganizer(state, {
      type: "duplicateSelected",
      newPageIds: ["copy-2", "copy-3"],
    });
    expect(ids(state)).toEqual([
      "page-1",
      "page-2",
      "copy-2",
      "page-3",
      "copy-3",
      "page-4",
    ]);
    expect(state.ui.selectedPageIds).toEqual(["copy-2", "copy-3"]);
    expectInvariant(state);
  });

  test("refuses deleting every page and toggles all-page selection", () => {
    let state = stateWith(2);
    state = reducePageOrganizer(state, { type: "toggleSelectAll" });
    expect(state.ui.selectedPageIds).toEqual(["page-1", "page-2"]);
    const unchanged = reducePageOrganizer(state, { type: "deleteSelected" });
    expect(ids(unchanged)).toEqual(["page-1", "page-2"]);
    state = reducePageOrganizer(state, { type: "toggleSelectAll" });
    expect(state.ui.selectedPageIds).toEqual([]);
    expectInvariant(state);
  });

  test("undo and redo return to exact fixed points", () => {
    let state = stateWith();
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-2"],
    });
    const original = state;
    state = reducePageOrganizer(state, { type: "rotateSelected", degrees: 90 });
    state = reducePageOrganizer(state, { type: "rotateSelected", degrees: 90 });
    const changed = state;
    state = reducePageOrganizer(state, { type: "undo" });
    state = reducePageOrganizer(state, { type: "undo" });
    expect(state.history.present).toEqual(original.history.present);
    expect(isPageOrganizerDirty(state)).toBe(false);
    state = reducePageOrganizer(state, { type: "redo" });
    state = reducePageOrganizer(state, { type: "redo" });
    expect(state.history.present).toEqual(changed.history.present);
    expectInvariant(state);
  });

  test("bounds retained history for long editing sessions", () => {
    let state = stateWith();
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-1"],
    });
    for (let index = 0; index < 120; index += 1) {
      state = reducePageOrganizer(state, {
        type: "rotateSelected",
        degrees: 90,
      });
    }
    expect(state.history.past).toHaveLength(100);
    expectInvariant(state);
  });

  test("stays dirty after undoing every retained entry beyond the history cap", () => {
    let state = stateWith();
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-1"],
    });
    for (let index = 0; index < 101; index += 1) {
      state = reducePageOrganizer(state, {
        type: "rotateSelected",
        degrees: 90,
      });
    }
    for (let index = 0; index < 100; index += 1) {
      state = reducePageOrganizer(state, { type: "undo" });
    }

    expect(state.history.past).toHaveLength(0);
    expect(state.history.present).not.toEqual(state.history.initial);
    expect(isPageOrganizerDirty(state)).toBe(true);
  });
});

test("per-page crops commit atomically and undo to the original crop fixed point", () => {
  const initialCrop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 };
  const initial = createPageOrganizerState({
    pages: pages(3).map((page) => ({ ...page, crop: initialCrop })),
  });
  const crops = new Map([
    ["page-1", { x: 0.2, y: 0.1, width: 0.6, height: 0.7 }],
    ["page-2", { x: 0.1, y: 0.05, width: 0.8, height: 0.9 }],
  ]);
  const changed = reducePageOrganizer(initial, { type: "setPageCrops", crops });
  expect(changed.history.past).toHaveLength(1);
  for (const page of changed.history.present.pages) {
    expect(page.crop).toEqual(crops.get(page.id) ?? initialCrop);
  }
  const undone = reducePageOrganizer(changed, { type: "undo" });
  expect(undone.history.present).toEqual(initial.history.present);
  expect(reducePageOrganizer(undone, { type: "redo" }).history.present).toEqual(
    changed.history.present,
  );
  const reset = reducePageOrganizer(changed, {
    type: "setPageCrops",
    crops: new Map([
      ["page-1", null],
      ["page-2", null],
    ]),
  });
  expect(reset.history.present.pages.at(0)).not.toHaveProperty("crop");
  expect(reset.history.present.pages.at(1)).not.toHaveProperty("crop");
  expect(reset.history.present.pages.at(2)?.crop).toEqual(initialCrop);
  expect(reducePageOrganizer(reset, { type: "undo" }).history.present).toEqual(
    changed.history.present,
  );
});

test("identical per-page crops do not create an undo entry", () => {
  const initial = stateWith();
  const crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  const cropped = reducePageOrganizer(initial, {
    type: "setPageCrops",
    crops: new Map([["page-1", crop]]),
  });
  const repeated = reducePageOrganizer(cropped, {
    type: "setPageCrops",
    crops: new Map([["page-1", crop]]),
  });
  expect(repeated.history.past).toHaveLength(1);
});

describe("clean scan review", () => {
  const RUN = "9a0f3c2e-5d1b-4c7a-8e6f-1b2c3d4e5f60";
  const geometry = {
    pageSize: { widthPoints: 612, heightPoints: 792 },
    dpi: 150,
  } satisfies CleanScanGeometry;
  const cleaned = (pageId: string) =>
    ({
      type: "preview",
      pageId,
      scan: {
        type: "cleaned",
        image: {
          pixels: new Uint8Array(4 * 6).fill(255),
          width: 4,
          height: 6,
          format: "grayscale",
        },
        appliedQuad: null,
        skewDegrees: 0,
        contentBox: { x: 0, y: 0, width: 4, height: 6 },
      },
    }) satisfies CleanScanPageReview;

  const reviewing = (pageIds: readonly string[]) =>
    reducePageOrganizer(stateWith(), {
      type: "startCleanScan",
      runId: RUN,
      pageIds,
      options: DEFAULT_CLEAN_SCAN_OPTIONS,
    });

  const reviewed = (state: PageOrganizerState, pageId: string) =>
    reducePageOrganizer(state, {
      type: "cleanScanPageReviewed",
      runId: RUN,
      review: cleaned(pageId),
      geometry,
    });

  const reviewTypes = (state: PageOrganizerState) =>
    state.cleanScan?.review.pages.map((page) => page.type);

  test("defaults to grayscale with crop and deskew on", () => {
    expect(DEFAULT_CLEAN_SCAN_OPTIONS).toEqual({
      output: "grayscale",
      contentCrop: "on",
      deskew: "on",
    });
  });

  test("a result from an abandoned run never reaches the current review", () => {
    const state = reviewing(["page-1"]);
    const stale = reducePageOrganizer(state, {
      type: "cleanScanPageReviewed",
      runId: "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
      review: cleaned("page-1"),
      geometry,
    });
    const staleFailure = reducePageOrganizer(state, {
      type: "cleanScanPageFailed",
      runId: "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
      failure: {
        pageId: "page-1",
        reason: "engine-timeout",
        message: "The scan engine request timed out",
      },
    });

    expect(stale).toBe(state);
    expect(staleFailure).toBe(state);
  });

  test("an engine failure is kept for its page, which stays pending and untouched", () => {
    const failure = {
      pageId: "page-2",
      reason: "engine-timeout",
      message: "The scan engine request timed out",
    } as const;
    const state = reducePageOrganizer(reviewing(["page-1", "page-2"]), {
      type: "cleanScanPageFailed",
      runId: RUN,
      failure,
    });
    const committed = reducePageOrganizer(
      reducePageOrganizer(reviewed(state, "page-1"), {
        type: "applyAllCleanScanPages",
      }),
      { type: "commitCleanScan" },
    );

    expect(state.cleanScan?.failures).toEqual([failure]);
    expect(reviewTypes(state)).toEqual(["pending", "pending"]);
    expect(
      committed.history.present.pages.map((page) => page.cleanScanId),
    ).toEqual([`${RUN}:page-1`, undefined, undefined, undefined]);
  });

  test("undo reverts the user's decisions but never returns a finished page to pending", () => {
    let state = reviewed(reviewing(["page-1", "page-2"]), "page-1");
    state = reducePageOrganizer(state, {
      type: "applyCleanScanPage",
      pageId: "page-1",
    });
    // page-2 finishes after the user already applied page-1.
    state = reviewed(state, "page-2");
    state = reducePageOrganizer(state, {
      type: "rejectCleanScanPage",
      pageId: "page-2",
    });
    expect(reviewTypes(state)).toEqual(["applied", "rejected"]);

    state = reducePageOrganizer(state, { type: "undoCleanScanReview" });
    expect(reviewTypes(state)).toEqual(["applied", "preview"]);
    state = reducePageOrganizer(state, { type: "undoCleanScanReview" });
    expect(reviewTypes(state)).toEqual(["preview", "preview"]);
    expect(reducePageOrganizer(state, { type: "undoCleanScanReview" })).toEqual(
      state,
    );
  });

  test("committing applies only accepted pages as one undoable plan edit", () => {
    let state = reviewed(
      reviewed(reviewing(["page-1", "page-3"]), "page-1"),
      "page-3",
    );
    state = reducePageOrganizer(state, {
      type: "applyCleanScanPage",
      pageId: "page-3",
    });
    const committed = reducePageOrganizer(state, { type: "commitCleanScan" });

    expect(committed.cleanScan).toBeNull();
    expect(isPageOrganizerDirty(committed)).toBe(true);
    expect(committed.history.past).toHaveLength(1);
    expect(
      committed.history.present.pages.map((page) => page.cleanScanId),
    ).toEqual([undefined, undefined, `${RUN}:page-3`, undefined]);

    const undone = reducePageOrganizer(committed, { type: "undo" });
    expect(isPageOrganizerDirty(undone)).toBe(false);
    const redone = reducePageOrganizer(undone, { type: "redo" });
    expect(transformPagePlanEntries(redone).at(2)).toEqual({
      id: "page-3",
      sourceId: "source-a",
      sourcePageIndex: 2,
      rotation: 0,
      scan: { ...geometry, image: cleaned("page-3").scan.image },
    });
  });

  test("cancelling discards the review without touching the plan", () => {
    const state = reducePageOrganizer(
      reviewed(reviewing(["page-1"]), "page-1"),
      { type: "applyAllCleanScanPages" },
    );
    const cancelled = reducePageOrganizer(state, { type: "cancelCleanScan" });

    expect(cancelled.cleanScan).toBeNull();
    expect(cancelled.history).toBe(state.history);
    expect(isPageOrganizerDirty(cancelled)).toBe(false);
  });

  test("a cleaned page keeps its scan through rotation and duplication", () => {
    let state = reducePageOrganizer(
      reducePageOrganizer(reviewed(reviewing(["page-1"]), "page-1"), {
        type: "applyAllCleanScanPages",
      }),
      { type: "commitCleanScan" },
    );
    state = reducePageOrganizer(state, {
      type: "replaceSelection",
      pageIds: ["page-1"],
    });
    state = reducePageOrganizer(state, { type: "rotateSelected", degrees: 90 });
    state = reducePageOrganizer(state, {
      type: "duplicateSelected",
      newPageIds: ["page-1-copy"],
    });

    const [first, copy] = transformPagePlanEntries(state);
    expect(first?.rotation).toBe(90);
    expect(copy?.rotation).toBe(90);
    expect(first?.scan).toBeDefined();
    expect(copy?.scan).toBe(first?.scan);
  });
});
