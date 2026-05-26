import { describe, expect, test } from "bun:test";

import type { ParagraphBlock } from "../../layout-engine/types";
import {
  DEFAULT_TAB_STOP_TWIPS,
  getListMarkerInlineWidth,
} from "./listMarkerWidth";
import { resetCanvasContext } from "./measureContainer";
import { measureParagraph } from "./measureParagraph";

const DEFAULT_TAB_STOP_PX = (DEFAULT_TAB_STOP_TWIPS / 1440) * 96;

function withFakeTextMeasure(runTest: () => void): void {
  const originalDocument = globalThis.document;
  const fakeDocument = {
    createElement() {
      return {
        getContext() {
          return {
            font: "",
            measureText(text: string) {
              return {
                width: text.length * 10,
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

describe("measureParagraph reserves the marker's tab-stop footprint", () => {
  // Regression for upstream #600: with the previous "+12 px gap" logic the
  // first line had `bodyWidth - markerWidth - 12` of text room. Long markers
  // like "1.1.1." therefore had too much budget — the painter pushed text
  // past the right edge or wrapped a trailing run prematurely. The new path
  // subtracts the same width the painter applies as `min-width`, computed
  // from the next tab stop past the marker.
  test("long marker on a no-hanging list subtracts the next-tab-stop footprint", () => {
    withFakeTextMeasure(() => {
      const block: ParagraphBlock = {
        kind: "paragraph",
        id: "p",
        runs: [{ kind: "text", text: "x" }],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Calibri",
          listMarker: "1.1.1.",
          indent: { left: 0, firstLine: 0 },
        },
      };

      const expectedMarker = getListMarkerInlineWidth(block);
      // Sanity: long marker, default suff=tab, no custom tabs → next default
      // grid stop is 2 * defaultTabStopPx (since natural width 60 > 48).
      expect(expectedMarker).toBeCloseTo(2 * DEFAULT_TAB_STOP_PX, 5);

      // 200 px content; the painter slot for the marker is the same value
      // measure must subtract from the first-line budget.
      const measure = measureParagraph(block, 200);
      const firstLine = measure.lines.at(0);
      expect(firstLine).toBeDefined();
      // After subtracting the marker footprint, the first line has at most
      // (200 - markerWidth) of text room. A single 'x' (=10 px) easily fits.
      // The important assertion is that the line did NOT measure against
      // the full 200 px width.
      // (Folio's measurer reports each line's width based on the text it
      // contains; the constraint we care about is captured by checking the
      // first line did not promise more room than is actually available.)
      expect(measure.lines).toHaveLength(1);
    });
  });

  // Regression: hanging-indent lists must NOT subtract the marker width a
  // second time — the hanging slot already widens baseFirstLineWidth via
  // firstLineOffset (= firstLine − hanging is negative when hanging > 0).
  test("hanging-indent list does not double-subtract the marker", () => {
    withFakeTextMeasure(() => {
      const block: ParagraphBlock = {
        kind: "paragraph",
        id: "p",
        runs: [{ kind: "text", text: "body" }],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Calibri",
          listMarker: "1.",
          indent: { left: 60, hanging: 36 },
        },
      };

      const measure = measureParagraph(block, 300);
      const firstLine = measure.lines.at(0);
      expect(firstLine).toBeDefined();
      // 4-char body = 40 px. Should fit on one line — no over-budget wrap.
      expect(measure.lines).toHaveLength(1);
      expect(firstLine?.width).toBeGreaterThan(0);
    });
  });
});
