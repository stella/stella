import { describe, expect, test } from "bun:test";

import {
  getFileRowClickIntent,
  getFolderClickIntent,
  orderSelectedIds,
} from "./tree-view-selection.logic";

describe("folder row clicks", () => {
  test("modifier-click toggles selection without navigation", () => {
    expect(
      getFolderClickIntent({
        currentFolderId: "parent",
        hasModifier: true,
      }),
    ).toEqual({ type: "toggle-selection" });
  });

  test("plain drill-down click clears selection without selecting the parent folder", () => {
    expect(
      getFolderClickIntent({
        currentFolderId: "parent",
        hasModifier: false,
      }),
    ).toEqual({ type: "clear-and-navigate" });
  });

  test("plain tree click clears selection before toggling folder expansion", () => {
    expect(
      getFolderClickIntent({
        currentFolderId: undefined,
        hasModifier: false,
      }),
    ).toEqual({ type: "clear-and-toggle" });
  });
});

describe("ordering a selection for bulk open", () => {
  test("follows visible order, not click order", () => {
    expect(
      orderSelectedIds(new Set(["c", "a", "b"]), ["a", "b", "c", "d"]),
    ).toEqual(["a", "b", "c"]);
  });

  test("keeps ids outside the visible order, after it, in selection order", () => {
    expect(
      orderSelectedIds(new Set(["hidden-2", "b", "hidden-1", "a"]), ["a", "b"]),
    ).toEqual(["a", "b", "hidden-2", "hidden-1"]);
  });

  test("is a fixed point on an already ordered selection", () => {
    const ordered = ["a", "b", "c"];
    const once = orderSelectedIds(new Set(["a", "b", "c"]), ordered);
    expect(orderSelectedIds(new Set(once), ordered)).toEqual(once);
  });
});

describe("file row clicks", () => {
  test("a plain click always selects, so the range anchor cannot go stale", () => {
    expect(
      getFileRowClickIntent({ clickCount: 1, hasMeta: false, hasShift: false }),
    ).toEqual({
      type: "select",
      meta: false,
      shift: false,
      snapshotSelection: true,
    });
  });

  test("a modifier click selects without snapshotting: it collapses nothing", () => {
    for (const mods of [
      { hasMeta: true, hasShift: false },
      { hasMeta: false, hasShift: true },
    ]) {
      expect(getFileRowClickIntent({ clickCount: 1, ...mods })).toEqual({
        type: "select",
        meta: mods.hasMeta,
        shift: mods.hasShift,
        snapshotSelection: false,
      });
    }
  });

  test("the closing click of a double-click leaves the selection alone", () => {
    expect(
      getFileRowClickIntent({ clickCount: 2, hasMeta: false, hasShift: false }),
    ).toEqual({ type: "keep-selection" });
  });
});
