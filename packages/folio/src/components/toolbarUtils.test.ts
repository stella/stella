import { describe, expect, test } from "bun:test";

import type { SelectionFormatting } from "./toolbarPrimitives";
import { areSelectionFormattingEqual } from "./toolbarUtils";

describe("selection formatting equality", () => {
  test("treats identical nullable values as equal", () => {
    expect(areSelectionFormattingEqual(undefined, undefined)).toBe(true);
    expect(areSelectionFormattingEqual(null, null)).toBe(true);
  });

  test("treats one missing formatting value as different", () => {
    expect(areSelectionFormattingEqual(undefined, {})).toBe(false);
    expect(areSelectionFormattingEqual({}, null)).toBe(false);
  });

  test("compares formatting fields structurally", () => {
    const formatting: SelectionFormatting = {
      bold: true,
      fontSize: 22,
      listState: { type: "bullet", level: 1, isInList: true },
    };

    expect(
      areSelectionFormattingEqual(formatting, {
        bold: true,
        fontSize: 22,
        listState: { type: "bullet", level: 1, isInList: true },
      }),
    ).toBe(true);
    expect(
      areSelectionFormattingEqual(formatting, {
        bold: true,
        fontSize: 22,
        listState: { type: "number", level: 1, isInList: true },
      }),
    ).toBe(false);
  });
});
