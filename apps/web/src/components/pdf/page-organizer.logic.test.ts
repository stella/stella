import { describe, expect, test } from "bun:test";

import {
  createPageOrganizerState,
  getPageMoveDestination,
  isPageOrganizerDirty,
  reducePageOrganizer,
  type OrganizerPage,
  type PageOrganizerState,
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
