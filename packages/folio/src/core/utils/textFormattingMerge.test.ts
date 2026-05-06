import { describe, expect, test } from "bun:test";

import { mergeTextFormatting } from "./textFormattingMerge";

describe("mergeTextFormatting", () => {
  test("per-slot merge of fontFamily preserves inherited ascii", () => {
    const result = mergeTextFormatting(
      { fontFamily: { ascii: "Arial Narrow" } },
      { fontFamily: { eastAsia: "Calibri" } },
    );

    expect(result?.fontFamily).toEqual({
      ascii: "Arial Narrow",
      eastAsia: "Calibri",
    });
  });

  test("shallow-merges object-shaped fields", () => {
    const result = mergeTextFormatting(
      { underline: { style: "single", color: { rgb: "FF0000" } } },
      { underline: { style: "double" } },
    );

    expect(result?.underline).toEqual({
      style: "double",
      color: { rgb: "FF0000" },
    });
  });

  test('color w:val="auto" clears an inherited explicit color', () => {
    const result = mergeTextFormatting(
      { color: { rgb: "FF0000" } },
      { color: { auto: true } },
    );

    expect(result?.color).toEqual({ auto: true });
  });
});
