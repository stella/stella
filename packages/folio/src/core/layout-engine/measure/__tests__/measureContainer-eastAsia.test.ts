/**
 * `eastAsiaFontFamily` makes the measurer pick the East-Asian font for CJK code
 * points and the base font for the rest, matching the painter's per-script span
 * split so wrapping and click positioning stay in sync.
 */

import { describe, expect, test } from "bun:test";

import { buildRunFontStyle } from "../measureHelpers";
import { measureRun, measureTextWidth } from "../measureProvider";
import type { FakeCharWidth } from "./fakeTextMeasure";
import { withFakeTextMeasure } from "./fakeTextMeasure";

// CJK or Latin code points measure 100px when the active canvas font is the EA
// test font, 10px otherwise — so a test can prove the font was switched.
const eaAwareCharWidth: FakeCharWidth = (_char, font) =>
  font.includes("FolioEaTestFont") ? 100 : 10;

describe("measureTextWidth with eastAsiaFontFamily", () => {
  test("measures CJK with the EA font and Latin with the base font", () => {
    withFakeTextMeasure(
      () => {
        const baseOnly = measureTextWidth("Aあ", {
          fontFamily: "FolioBaseTestFont",
          fontSize: 12,
        });
        expect(baseOnly).toBe(20); // both chars at base font (10 + 10)

        const mixed = measureTextWidth("Aあ", {
          fontFamily: "FolioBaseTestFont",
          eastAsiaFontFamily: "FolioEaTestFont",
          fontSize: 12,
        });
        expect(mixed).toBe(110); // A = 10 (base), あ = 100 (EA)
      },
      { charWidth: eaAwareCharWidth },
    );
  });

  test("falls back to the base font for CJK when no EA font is set", () => {
    withFakeTextMeasure(
      () => {
        expect(
          measureTextWidth("世界", {
            fontFamily: "FolioBaseTestFont",
            fontSize: 12,
          }),
        ).toBe(20); // both CJK at base font → 10 + 10
      },
      { charWidth: eaAwareCharWidth },
    );
  });

  test("gates the EA font off for letter-spaced runs so measure matches measureRun", () => {
    withFakeTextMeasure(
      () => {
        const style = {
          fontFamily: "FolioBaseTestFont",
          eastAsiaFontFamily: "FolioEaTestFont",
          fontSize: 12,
          letterSpacing: 5,
        };
        // CSS letter-spacing cannot bridge the painter's per-script sibling
        // spans, so a letter-spaced run keeps the base font for CJK too. "Aあ":
        // both at base (10 + 10) + 5 * (2 - 1) = 25 — not the EA width.
        expect(measureTextWidth("Aあ", style)).toBe(25);
        expect(measureRun("Aあ", style).width).toBe(25);
      },
      { charWidth: eaAwareCharWidth },
    );
  });

  test("counts letter spacing by code point for astral text (base font), matching measureRun", () => {
    withFakeTextMeasure(
      () => {
        const style = {
          fontFamily: "FolioBaseTestFont",
          eastAsiaFontFamily: "FolioEaTestFont",
          fontSize: 12,
          letterSpacing: 5,
        };
        // "A𠀀B" is 3 code points → 2 gaps (not 3 from UTF-16 length); base font
        // throughout (letter-spaced): glyphs 10 + 10 + 10 = 30, plus 5 * 2 = 10.
        expect(measureTextWidth("A𠀀B", style)).toBe(40);
        expect(measureRun("A𠀀B", style).width).toBe(40);
      },
      { charWidth: eaAwareCharWidth },
    );
  });
});

describe("measureRun with eastAsiaFontFamily", () => {
  test("per-character widths use the EA font for CJK code points", () => {
    withFakeTextMeasure(
      () => {
        const { charWidths, width } = measureRun("AあB", {
          fontFamily: "FolioBaseTestFont",
          eastAsiaFontFamily: "FolioEaTestFont",
          fontSize: 12,
        });
        expect(charWidths).toEqual([10, 100, 10]); // A base, あ EA, B base
        expect(width).toBe(120);
      },
      { charWidth: eaAwareCharWidth },
    );
  });

  test("measures an astral CJK ideograph with the EA font, keeping UTF-16-aligned widths", () => {
    withFakeTextMeasure(
      () => {
        // "A𠀀B": the Ext-B ideograph is a surrogate pair (2 UTF-16 units), so
        // charWidths has 4 entries — the astral glyph's width on the first unit
        // and 0 on the second — and it is measured with the EA font.
        const { charWidths, width } = measureRun("A𠀀B", {
          fontFamily: "FolioBaseTestFont",
          eastAsiaFontFamily: "FolioEaTestFont",
          fontSize: 12,
        });
        expect(charWidths).toEqual([10, 100, 0, 10]);
        expect(width).toBe(120);
      },
      { charWidth: eaAwareCharWidth },
    );
  });
});

describe("buildRunFontStyle", () => {
  test("carries eastAsiaFontFamily so every measurement path measures CJK with the EA font", () => {
    const style = buildRunFontStyle(
      { fontFamily: "Latin", eastAsiaFontFamily: "Mincho", fontSize: 12 },
      "Arial",
      11,
    );
    expect(style.fontFamily).toBe("Latin");
    expect(style.eastAsiaFontFamily).toBe("Mincho");
    expect(style.fontSize).toBe(12);
  });

  test("applies the family/size fallbacks when the run declares neither", () => {
    const style = buildRunFontStyle({}, "Arial", 11);
    expect(style.fontFamily).toBe("Arial");
    expect(style.fontSize).toBe(11);
    expect(style.eastAsiaFontFamily).toBeUndefined();
  });
});
