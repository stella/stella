import { describe, expect, test } from "bun:test";

import { calculateTabWidth } from "../../prosemirror/utils/tabCalculator";
import type { TabContext } from "../../prosemirror/utils/tabCalculator";
import { clearAllCaches } from "./cache";
import { resetCanvasContext } from "./measureContainer";
import { measureParagraph } from "./measureParagraph";

// Mirrors the fake measurer used in measureParagraph.test.ts (5px lowercase,
// 10px uppercase) so the test agrees with the rest of the suite on widths.
function withFakeTextMeasure(runTest: () => void): void {
  const originalDocument = globalThis.document;
  const fakeDocument = {
    createElement() {
      return {
        getContext() {
          return {
            font: "",
            measureText(this: { font: string }, text: string) {
              let width = 0;
              for (const char of text) {
                const isUppercase = char >= "A" && char <= "Z";
                width += isUppercase ? 10 : 5;
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
  clearAllCaches();
  resetCanvasContext();

  try {
    runTest();
  } finally {
    resetCanvasContext();
    clearAllCaches();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
}

// Regression: the legacy `computeTabWidth` in measureParagraph ignored the
// tab stop's `val` field, so a right (`end`) or center stop was measured as
// `stopPx + followingTextWidth`. The painter already right-/center-anchors
// such content via `calculateTabWidth`, so the wrap fired in the measurer
// but not in the painter. See eigenpal #576.
describe("measureParagraph — right/center tab stops (eigenpal #576)", () => {
  test("right tab followed by short text does not wrap", () => {
    withFakeTextMeasure(() => {
      // Right tab stop at 5000 twips ≈ 333.33px. With the bug, the measurer
      // advances to the stop unconditionally (tab ≈ 308.33px on top of the
      // 25px title), then the trailing "page" run (20px) overflows the
      // 340px line and starts a new one. After the fix, end-alignment
      // subtracts the trailing width: the tab pulls "page" right of the
      // stop and the whole line fits.
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "right-tab",
          runs: [
            { kind: "text", text: "Title", fontSize: 11 },
            { kind: "tab" },
            { kind: "text", text: "page", fontSize: 11 },
          ],
          attrs: {
            tabs: [{ val: "end", pos: 5000 }],
          },
        },
        340,
      );

      expect(measure.lines).toHaveLength(1);
    });
  });

  test("center tab followed by text does not wrap", () => {
    withFakeTextMeasure(() => {
      // Center stop at 5000 twips ≈ 333.33px. "center" is 30px, so a
      // center-aligned anchor needs only `tabWidth = (333.33 - 20) - 15`,
      // putting the line at 333.33 + 15 = 348.33px — fits in 350. The
      // legacy measurer would report 20 + 313.33 + 30 = 363.33px and wrap.
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "center-tab",
          runs: [
            { kind: "text", text: "left", fontSize: 11 },
            { kind: "tab" },
            { kind: "text", text: "center", fontSize: 11 },
          ],
          attrs: {
            tabs: [{ val: "center", pos: 5000 }],
          },
        },
        350,
      );

      expect(measure.lines).toHaveLength(1);
    });
  });

  test("measurer agrees with calculateTabWidth on the right-tab line width", () => {
    withFakeTextMeasure(() => {
      const block = {
        kind: "paragraph" as const,
        id: "right-tab-width",
        runs: [
          { kind: "text" as const, text: "Title", fontSize: 11 },
          { kind: "tab" as const },
          { kind: "text" as const, text: "7", fontSize: 11 },
        ],
        attrs: {
          tabs: [{ val: "end" as const, pos: 5000 }],
        },
      };

      const measure = measureParagraph(block, 400);
      const line = measure.lines.at(0);
      expect(line).toBeDefined();

      // What the painter computes end-to-end:
      //   title (5 chars × 5px = 25px) +
      //   tab width that anchors "7" right of the 5000-twip stop +
      //   "7" (10px)
      const titleWidth = 25;
      const followingWidth = 10;
      const tabContext: TabContext = {
        explicitStops: [{ val: "end", pos: 5000 }],
      };
      const tabResult = calculateTabWidth(titleWidth, tabContext, {
        followingWidth,
      });
      const painterLineWidth = titleWidth + tabResult.width + followingWidth;

      expect(
        Math.abs((line?.width ?? 0) - painterLineWidth),
      ).toBeLessThanOrEqual(0.5);
    });
  });
});
