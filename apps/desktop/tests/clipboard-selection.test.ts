import { describe, expect, test } from "bun:test";

import { clipboardSelection } from "../src/clipboard/clipboard-selection";

describe("ordered clipboard selection", () => {
  test("keeps click order, toggles off, and appends a reselected clip", () => {
    let selection: string[] = [];
    for (const id of ["third", "first", "second"]) {
      selection = clipboardSelection(selection, { type: "toggle", id });
    }
    expect(selection).toEqual(["third", "first", "second"]);
    selection = clipboardSelection(selection, { type: "toggle", id: "first" });
    expect(selection).toEqual(["third", "second"]);
    expect(
      clipboardSelection(selection, { type: "toggle", id: "first" }),
    ).toEqual(["third", "second", "first"]);
  });

  test("Escape clears every selected clip and clearing is idempotent", () => {
    const cleared = clipboardSelection(["third", "first", "second"], {
      type: "clear",
    });
    expect(cleared).toEqual([]);
    expect(clipboardSelection(cleared, { type: "clear" })).toEqual([]);
  });

  test("toggling an unselected clip twice restores the prior selection without mutating it", () => {
    const selection = ["third", "first"];
    expect(
      clipboardSelection(
        clipboardSelection(selection, { type: "toggle", id: "second" }),
        { type: "toggle", id: "second" },
      ),
    ).toEqual(selection);
    expect(selection).toEqual(["third", "first"]);
  });
});
