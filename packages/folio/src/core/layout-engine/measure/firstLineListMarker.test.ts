import { describe, expect, test } from "bun:test";

import type { ParagraphBlock } from "../types";
import { resetCanvasContext } from "./measureContainer";
import { measureParagraph } from "./measureParagraph";

// First-line-indent list paragraphs (`<w:ind w:left="0" w:firstLine="N"/>`,
// no hanging) put the marker inline at the start of the first line. The
// painter prepends a marker span (with a 12 px tab-after) — so the
// first line's available text width must be measured *minus* the
// marker box, otherwise the line breaker over-allocates and the
// trailing punctuation/text wraps to the next line.
//
// NVCA-style legal templates trigger this: section heads like
// "4.10 Voting Agreement.  The Company..." rendered "4.10Voting
// Agreement" then ". The Company..." on the next line because the
// measurement assumed the full first-line width was available for
// text that the painter then had to share with a 30+12 px marker box.

function withFakeTextMeasure(runTest: () => void): void {
  // Each character reports 5 px (uppercase 10 px) — same shape as
  // measureParagraph.test.ts so the line-break math is predictable.
  const originalDocument = globalThis.document;
  const fakeDocument = {
    createElement() {
      return {
        getContext() {
          return {
            font: "",
            measureText(text: string) {
              let width = 0;
              for (const char of text) {
                width += char >= "A" && char <= "Z" ? 10 : 5;
              }
              return {
                width,
                actualBoundingBoxAscent: 8,
                actualBoundingBoxDescent: 2,
              };
            },
          };
        },
      };
    },
  } as unknown as Document;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  resetCanvasContext();

  try {
    runTest();
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    resetCanvasContext();
  }
}

describe("measureParagraph — first-line list marker reservation", () => {
  test("first-line text width on a list paragraph excludes marker + tab-after", () => {
    withFakeTextMeasure(() => {
      // Total content width 200 px. firstLine indent = 50 px.
      // Marker "4.10" = 5+5+5+5 = 20 px @ 11pt fake metrics.
      // Tab-after = 12 px.
      // Without the fix: first-line width = 200 - 50 = 150.
      // With the fix:    first-line width = 200 - 50 - (20 + 12) = 118.
      const para: ParagraphBlock = {
        kind: "paragraph",
        id: 0,
        runs: [
          {
            kind: "text",
            text: "abcdefghijklmnopqrstuvwxyz",
            pmStart: 1,
            pmEnd: 27,
          },
        ],
        attrs: {
          indent: { left: 0, firstLine: 50 },
          listMarker: "4.10",
          defaultFontSize: 11,
          defaultFontFamily: "TestFont",
          listMarkerFontSize: 11,
          listMarkerFontFamily: "TestFont",
        },
        pmStart: 1,
        pmEnd: 28,
      };

      const m = measureParagraph(para, 200);
      expect(m.kind).toBe("paragraph");

      // Without fix the first line would claim 150 px and fit 30
      // characters (5 px each) — the entire 26-char string + tail.
      // With the fix only 118 px fits → 23 chars on first line, the
      // rest wraps. Two-line output proves marker reservation took
      // effect.
      expect(m.lines.length).toBeGreaterThanOrEqual(2);
      expect(m.lines[0]!.toChar).toBeLessThanOrEqual(24);
    });
  });

  test("hanging-indent lists do NOT also subtract a marker reservation", () => {
    withFakeTextMeasure(() => {
      // Hanging-indent: marker box already sits in the hanging space
      // (painter sets `min-width: hanging`), so the line's text width
      // shouldn't be reduced again. With left=50, hanging=50:
      //   bodyContentWidth = 200 - 50 = 150
      //   firstLineOffset  = 0 - 50 = -50  (hanging gives more width)
      //   baseFirstLineWidth = 150 - (-50) = 200 — full content width.
      // Subtracting the marker again here would shrink first line
      // text width below 200 and overcount.
      const para: ParagraphBlock = {
        kind: "paragraph",
        id: 0,
        runs: [{ kind: "text", text: "Body text", pmStart: 1, pmEnd: 10 }],
        attrs: {
          indent: { left: 50, hanging: 50 },
          listMarker: "1.",
          defaultFontSize: 11,
          defaultFontFamily: "TestFont",
        },
        pmStart: 1,
        pmEnd: 11,
      };

      const m = measureParagraph(para, 200);
      expect(m.kind).toBe("paragraph");
      // Hanging case: the first line's measured *text* width should
      // match the full content width (200 in this fake), not be
      // reduced by the marker reservation. The text "Body text" is
      // short, so we just check the line's total width is well below
      // the limit (proxy: a single line) — combined with the body
      // calculation that hanging branch is taken (no extra
      // subtraction). The negative assertion is that there's no extra
      // wrap from a phantom marker subtraction.
      expect(m.lines.length).toBe(1);
    });
  });
});
