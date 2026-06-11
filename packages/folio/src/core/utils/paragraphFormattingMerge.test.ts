import { describe, expect, test } from "bun:test";

import type { ParagraphFormatting } from "../types/document";
import { mergeParagraphFormatting } from "./paragraphFormattingMerge";

describe("mergeParagraphFormatting", () => {
  test("preserves explicit false overrides for inherited paragraph toggles", () => {
    const result = mergeParagraphFormatting(
      { keepNext: true, bidi: true },
      { keepNext: false, bidi: false },
    );

    expect(result?.keepNext).toBe(false);
    expect(result?.bidi).toBe(false);
  });

  test("merges nested paragraph property containers by field", () => {
    const result = mergeParagraphFormatting(
      {
        borders: { top: { style: "single", color: { rgb: "FF0000" } } },
        frame: { width: 1200, hAnchor: "margin" },
        numPr: { numId: 4 },
      },
      {
        borders: { bottom: { style: "double" } },
        frame: { height: 800 },
        numPr: { ilvl: 2 },
      },
    );

    expect(result?.borders).toEqual({
      top: { style: "single", color: { rgb: "FF0000" } },
      bottom: { style: "double" },
    });
    expect(result?.frame).toEqual({
      width: 1200,
      hAnchor: "margin",
      height: 800,
    });
    expect(result?.numPr).toEqual({ numId: 4, ilvl: 2 });
  });

  test("replaces tab collections and merges paragraph mark run properties", () => {
    const sourceTabs: NonNullable<ParagraphFormatting["tabs"]> = [
      { position: 720, alignment: "left" },
    ];

    const result = mergeParagraphFormatting(
      {
        tabs: [{ position: 360, alignment: "center" }],
        runProperties: {
          underline: { style: "single", color: { rgb: "FF0000" } },
        },
      },
      {
        tabs: sourceTabs,
        runProperties: { underline: { style: "double" } },
      },
    );

    expect(result?.tabs).toEqual(sourceTabs);
    expect(result?.tabs).not.toBe(sourceTabs);
    expect(result?.runProperties?.underline).toEqual({
      style: "double",
      color: { rgb: "FF0000" },
    });
  });
});
