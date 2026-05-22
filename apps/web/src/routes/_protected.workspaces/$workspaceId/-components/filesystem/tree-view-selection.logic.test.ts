import { describe, expect, test } from "bun:test";

import { getFolderClickIntent } from "./tree-view-selection.logic";

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
