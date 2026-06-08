// Regression tests for the bot review on PR #512 (eigenpal #576).
//
// Issues covered:
// 1. measurer must pass `decimalPrefixWidth` to `calculateTabWidth` so it
//    agrees with the painter on decimal tab advance (gemini HIGH on
//    measureParagraph.ts:831).
// 2. `measureInlineWidthAfterTab` must honour all RunFormatting fields on
//    a trailing FieldRun (gemini medium on measureParagraph.ts:309).
// 3. `measureInlineWidthAfterTab` must skip floating/anchored images, since
//    the painter lifts them out of the paragraph flow and only counts
//    `!isFloatingImageRun(run)` (codex P2 on measureParagraph.ts:305).

import { describe, expect, test } from "bun:test";

import {
  calculateTabWidth,
  type TabContext,
} from "../../prosemirror/utils/tabCalculator";
import { withFakeTextMeasure } from "./__tests__/fakeTextMeasure";
import { measureParagraph } from "./measureParagraph";

describe("measureParagraph — decimal tab stop (PR #512 gemini HIGH)", () => {
  test("decimal tab measurer matches painter (decimalPrefixWidth threaded)", () => {
    // Decimal stop at 3000 twips (200px). Text "12.34" follows the tab —
    // the painter aligns "12" left of the stop and "34" right of it via
    // `decimalPrefixWidth`. With the bug, the measurer omits that argument
    // and computes the tab as if the whole "12.34" anchored at the stop.
    withFakeTextMeasure(() => {
      const block = {
        kind: "paragraph" as const,
        id: "decimal-tab",
        runs: [
          { kind: "text" as const, text: "x", fontSize: 11 },
          { kind: "tab" as const },
          { kind: "text" as const, text: "12.34", fontSize: 11 },
        ],
        attrs: {
          tabs: [{ val: "decimal" as const, pos: 3000 }],
        },
      };

      const measure = measureParagraph(block, 400);
      const line = measure.lines.at(0);
      expect(line).toBeDefined();

      // What the painter would compute end-to-end at this position.
      // currentX after "x" = 5px. Following width = "12.34" = 25px.
      // Decimal prefix = "12" = 10px.
      const leadingWidth = 5;
      const followingWidth = 25;
      const decimalPrefixWidth = 10;
      const tabContext: TabContext = {
        explicitStops: [{ val: "decimal", pos: 3000 }],
      };
      const tabResult = calculateTabWidth(leadingWidth, tabContext, {
        followingWidth,
        decimalPrefixWidth,
      });
      const painterLineWidth = leadingWidth + tabResult.width + followingWidth;

      expect(
        Math.abs((line?.width ?? 0) - painterLineWidth),
      ).toBeLessThanOrEqual(0.5);
    });
  });

  test("decimal prefix includes math runs after the tab", () => {
    withFakeTextMeasure(() => {
      const block = {
        kind: "paragraph" as const,
        id: "decimal-tab-math",
        runs: [
          { kind: "text" as const, text: "x", fontSize: 11 },
          { kind: "tab" as const },
          {
            kind: "math" as const,
            display: "inline" as const,
            ommlXml: "<m:oMath />",
            plainText: "12.34",
            fontSize: 11,
          },
        ],
        attrs: {
          tabs: [{ val: "decimal" as const, pos: 3000 }],
        },
      };

      const measure = measureParagraph(block, 400);
      const line = measure.lines.at(0);
      expect(line).toBeDefined();

      const leadingWidth = 5;
      const followingWidth = 25;
      const decimalPrefixWidth = 10;
      const tabContext: TabContext = {
        explicitStops: [{ val: "decimal", pos: 3000 }],
      };
      const tabResult = calculateTabWidth(leadingWidth, tabContext, {
        followingWidth,
        decimalPrefixWidth,
      });
      const painterLineWidth = leadingWidth + tabResult.width + followingWidth;

      expect(
        Math.abs((line?.width ?? 0) - painterLineWidth),
      ).toBeLessThanOrEqual(0.5);
    });
  });

  test("decimal tab without a decimal point falls back to left-tab math", () => {
    // No "." in the trailing content → `decimalPrefixWidth` is 0, so the
    // tab advances to the stop and the line width is leading + (stop -
    // leading) + trailing = stop + trailing.
    withFakeTextMeasure(() => {
      const block = {
        kind: "paragraph" as const,
        id: "decimal-tab-noint",
        runs: [
          { kind: "text" as const, text: "x", fontSize: 11 },
          { kind: "tab" as const },
          { kind: "text" as const, text: "abc", fontSize: 11 },
        ],
        attrs: {
          tabs: [{ val: "decimal" as const, pos: 3000 }],
        },
      };

      const measure = measureParagraph(block, 400);
      const line = measure.lines.at(0);
      expect(line).toBeDefined();
      // Stop is 200px from origin; trailing "abc" = 15px. Total ≈ 215px.
      expect(line?.width ?? 0).toBeGreaterThan(210);
      expect(line?.width ?? 0).toBeLessThan(220);
    });
  });
});

describe("measureInlineWidthAfterTab — formatting parity (PR #512 gemini medium)", () => {
  test("field run with bold/italic measures the same as a styled text run", () => {
    // Two paragraphs: one with a styled TextRun after the tab, one with the
    // same fallback text inside a styled FieldRun. The measured line widths
    // must agree — the previous code hand-rolled `style` for fields and
    // dropped formatting, so a bold field would measure narrower than a bold
    // text run with identical glyphs.
    withFakeTextMeasure(() => {
      const baseAttrs = { tabs: [{ val: "end" as const, pos: 5000 }] };

      const textBlock = {
        kind: "paragraph" as const,
        id: "tab-text",
        runs: [
          { kind: "text" as const, text: "Hi", fontSize: 11 },
          { kind: "tab" as const },
          {
            kind: "text" as const,
            text: "PAGE",
            fontSize: 11,
            bold: true,
            italic: true,
          },
        ],
        attrs: baseAttrs,
      };

      const fieldBlock = {
        kind: "paragraph" as const,
        id: "tab-field",
        runs: [
          { kind: "text" as const, text: "Hi", fontSize: 11 },
          { kind: "tab" as const },
          {
            kind: "field" as const,
            fieldType: "OTHER" as const,
            fallback: "PAGE",
            fontSize: 11,
            bold: true,
            italic: true,
          },
        ],
        attrs: baseAttrs,
      };

      const textMeasure = measureParagraph(textBlock, 400);
      const fieldMeasure = measureParagraph(fieldBlock, 400);
      const textLine = textMeasure.lines.at(0);
      const fieldLine = fieldMeasure.lines.at(0);
      expect(textLine).toBeDefined();
      expect(fieldLine).toBeDefined();
      expect(
        Math.abs((textLine?.width ?? 0) - (fieldLine?.width ?? 0)),
      ).toBeLessThanOrEqual(0.5);
    });
  });
});

describe("measureInlineWidthAfterTab — floating images (PR #512 codex P2)", () => {
  test("a floating image after a right tab does not contribute to following width", () => {
    // With the bug, the inline-width helper counts the floating image's
    // `width` (300px) toward the right-tab anchor's trailing-width budget,
    // shrinking the tab advance even though the painter lifts the image out
    // of the line. Compare against a paragraph with NO image — the line
    // widths should match because both have the same inline content
    // (the title text only).
    withFakeTextMeasure(() => {
      const baseAttrs = { tabs: [{ val: "end" as const, pos: 5000 }] };

      const withFloat = {
        kind: "paragraph" as const,
        id: "tab-float",
        runs: [
          { kind: "text" as const, text: "Title", fontSize: 11 },
          { kind: "tab" as const },
          {
            kind: "image" as const,
            src: "img.png",
            width: 300,
            height: 100,
            wrapType: "square" as const,
          },
        ],
        attrs: baseAttrs,
      };

      const withoutFloat = {
        kind: "paragraph" as const,
        id: "tab-nofloat",
        runs: [
          { kind: "text" as const, text: "Title", fontSize: 11 },
          { kind: "tab" as const },
        ],
        attrs: baseAttrs,
      };

      const a = measureParagraph(withFloat, 400);
      const b = measureParagraph(withoutFloat, 400);
      const lineA = a.lines.at(0);
      const lineB = b.lines.at(0);
      expect(lineA).toBeDefined();
      expect(lineB).toBeDefined();
      expect(
        Math.abs((lineA?.width ?? 0) - (lineB?.width ?? 0)),
      ).toBeLessThanOrEqual(0.5);
    });
  });

  test("an inline image after a right tab still counts toward following width", () => {
    // Counter-test: inline images (no wrap type or `inline` displayMode) DO
    // participate in the line and must continue to be subtracted from the
    // tab advance — otherwise the right-anchor reserves too much room.
    withFakeTextMeasure(() => {
      const baseAttrs = { tabs: [{ val: "end" as const, pos: 5000 }] };

      const withInlineImage = {
        kind: "paragraph" as const,
        id: "tab-inline-img",
        runs: [
          { kind: "text" as const, text: "Title", fontSize: 11 },
          { kind: "tab" as const },
          {
            kind: "image" as const,
            src: "img.png",
            width: 40,
            height: 20,
          },
        ],
        attrs: baseAttrs,
      };

      const withoutImage = {
        kind: "paragraph" as const,
        id: "tab-no-img",
        runs: [
          { kind: "text" as const, text: "Title", fontSize: 11 },
          { kind: "tab" as const },
        ],
        attrs: baseAttrs,
      };

      const a = measureParagraph(withInlineImage, 400);
      const b = measureParagraph(withoutImage, 400);
      const lineA = a.lines.at(0);
      const lineB = b.lines.at(0);
      expect(lineA).toBeDefined();
      expect(lineB).toBeDefined();
      // The inline image adds 40px of trailing width that the right-anchor
      // subtracts from the tab advance, so the lines should still match: the
      // 40px reappears as image width in `lineA`. Both should be the same
      // total line width because the image is still rendered.
      expect(
        Math.abs((lineA?.width ?? 0) - (lineB?.width ?? 0)),
      ).toBeLessThanOrEqual(0.5);
    });
  });
});
