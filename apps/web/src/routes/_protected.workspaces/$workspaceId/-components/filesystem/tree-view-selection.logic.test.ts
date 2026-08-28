import { describe, expect, test } from "bun:test";

import {
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
