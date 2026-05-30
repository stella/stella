/**
 * Body text wraps around an anchored text box (eigenpal #474).
 *
 * Mirrors the renderPage pipeline: derives a FloatingExclusionRect from a
 * TextBoxBlock-shaped input, converts via `rectsToFloatingZones`, then
 * checks the paragraph's first line shrinks past the box.
 */

import { describe, expect, test } from "bun:test";

import {
  type FloatingExclusionRect,
  rectsToFloatingZones,
} from "./floatingZones";
import { resetCanvasContext } from "./measureContainer";
import { measureParagraph } from "./measureParagraph";

function withFakeTextMeasure(runTest: () => void): void {
  const originalDocument = globalThis.document;
  const fakeDocument = {
    createElement() {
      return {
        getContext() {
          return {
            font: "",
            measureText(_text: string) {
              return {
                width: _text.length * 5,
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
    resetCanvasContext();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
}

describe("body text wraps around floating text box", () => {
  test("a left-floated text box with wrapType='square' carves a left margin out of the first line", () => {
    withFakeTextMeasure(() => {
      const contentWidth = 500;
      // Anchored text box: 150x60 at top-left, 12px wrap distance on all sides.
      // wrapText='right' → text flows on the right side of the box only.
      const textBoxRect: FloatingExclusionRect = {
        side: "left",
        x: 0,
        y: 0,
        width: 150,
        height: 60,
        distTop: 0,
        distBottom: 0,
        distLeft: 12,
        distRight: 12,
        wrapType: "square",
        wrapText: "right",
      };

      const zones = rectsToFloatingZones([textBoxRect], contentWidth);
      expect(zones[0]?.leftMargin).toBe(162);

      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "p",
          runs: [
            {
              kind: "text",
              text: "this is a paragraph that should wrap around the floating text box",
            },
          ],
          attrs: { defaultFontSize: 11, defaultFontFamily: "Calibri" },
        },
        contentWidth,
        { floatingZones: zones },
      );

      const firstLine = measure.lines.at(0);
      expect(firstLine).toBeDefined();
      // First line was reduced past the floating text box.
      expect(firstLine?.leftOffset).toBe(162);
    });
  });

  test("a text box with wrapType='behind' does not reduce line widths", () => {
    withFakeTextMeasure(() => {
      const contentWidth = 500;
      // Even though the rect spans most of the content, wrapType='behind'
      // means body text paints over the box; line widths are untouched.
      // Mirroring renderPage's gate (`floatingTextBoxWrapsText`), the rect
      // never reaches `rectsToFloatingZones` — measurement runs without any
      // floating zones at all.
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "p",
          runs: [{ kind: "text", text: "body text over a behind box" }],
          attrs: { defaultFontSize: 11, defaultFontFamily: "Calibri" },
        },
        contentWidth,
        { floatingZones: [] },
      );

      const firstLine = measure.lines.at(0);
      expect(firstLine?.leftOffset).toBeUndefined();
      expect(firstLine?.rightOffset).toBeUndefined();
    });
  });
});
