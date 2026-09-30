import { expect, test } from "bun:test";

import { buildBoldRanges } from "@/api/lib/legal-search/parsers/libpdf-utils";

test("keeps the entire line when span spacing differs or a prefix is unmatched", () => {
  for (const lineText of [
    "prefix words suffix",
    "prefix  words suffix",
    "unmatched prefix suffix",
  ]) {
    const ranges = buildBoldRanges(
      [
        {
          text: "prefix  words",
          bbox: { x: 0, width: 20 },
          fontSize: 12,
          fontName: "Regular",
        },
        {
          text: "suffix",
          bbox: { x: 20, width: 20 },
          fontSize: 12,
          fontName: "Bold",
        },
      ],
      lineText,
    );
    expect(
      ranges.map(({ start, end }) => lineText.slice(start, end)).join(""),
    ).toBe(lineText);
    expect(ranges.at(0)?.start).toBe(0);
    expect(ranges.at(-1)?.bold).toBe(true);
    expect(ranges.at(-1)?.start).toBe(lineText.indexOf("suffix"));
  }
});
