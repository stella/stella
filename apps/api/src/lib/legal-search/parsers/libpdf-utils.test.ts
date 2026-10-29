import { expect, test } from "bun:test";

import {
  buildBoldRanges,
  buildFontStyleRanges,
} from "@/api/lib/legal-search/parsers/libpdf-utils";

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

test("font style ranges retain independent bold and italic runs without changing bold-only ranges", () => {
  const fonts = [
    "ArialMT",
    "Arial-ItalicMT",
    "Arial-BoldItalicMT",
    "Arial-BoldMT",
    "Helvetica-Oblique",
  ];
  const spans = fonts.map((fontName, index) => ({
    text: String(index + 1),
    bbox: { x: index * 10, width: 10 },
    fontSize: 12,
    fontName,
  }));
  const lineText = "1 2 3 4 5";
  expect(buildFontStyleRanges(spans, lineText)).toEqual([
    { start: 0, end: 2, bold: false, italic: false },
    { start: 2, end: 4, bold: false, italic: true },
    { start: 4, end: 6, bold: true, italic: true },
    { start: 6, end: 8, bold: true, italic: false },
    { start: 8, end: 9, bold: false, italic: true },
  ]);
  expect(buildBoldRanges(spans, lineText)).toEqual([
    { start: 0, end: 4, bold: false },
    { start: 4, end: 8, bold: true },
    { start: 8, end: 9, bold: false },
  ]);
});
