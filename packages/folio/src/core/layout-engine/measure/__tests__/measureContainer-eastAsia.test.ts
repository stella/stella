/**
 * `eastAsiaFontFamily` makes the measurer pick the East-Asian font for CJK code
 * points and the base font for the rest, matching the painter's per-script span
 * split so wrapping and click positioning stay in sync.
 */

import { describe, expect, test } from "bun:test";

import { measureRun, measureTextWidth } from "../measureContainer";
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

  test("applies letter spacing once across the whole mixed string", () => {
    withFakeTextMeasure(
      () => {
        // glyphs 10 (base) + 100 (EA) = 110, plus letterSpacing 5 * (2 - 1) = 5
        expect(
          measureTextWidth("Aあ", {
            fontFamily: "FolioBaseTestFont",
            eastAsiaFontFamily: "FolioEaTestFont",
            fontSize: 12,
            letterSpacing: 5,
          }),
        ).toBe(115);
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
});
