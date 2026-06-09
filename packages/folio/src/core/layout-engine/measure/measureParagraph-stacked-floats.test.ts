import { describe, expect, test } from "bun:test";

import {
  fixedCharWidth,
  withFakeTextMeasure,
} from "./__tests__/fakeTextMeasure";
import { measureParagraph } from "./measureParagraph";

const fakeMeasure = { charWidth: fixedCharWidth(5) };

describe("measureParagraph skips lines past obstructing floats", () => {
  // Regression: a float consuming nearly the full content width leaves no
  // usable horizontal segment for body text. Previously the line tried to
  // render in the ~tiny remainder, collapsing to ~1 glyph per line. Word
  // and upstream eigenpal (#596) push the line past the float instead.
  test("first line is bumped past a near-full-width float", () => {
    withFakeTextMeasure(() => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "p",
          runs: [
            {
              kind: "text",
              text: "the quick brown fox jumps over the lazy dog",
            },
          ],
          attrs: { defaultFontSize: 11, defaultFontFamily: "Calibri" },
        },
        500,
        {
          floatingZones: [
            {
              leftMargin: 0,
              rightMargin: 485,
              topY: 0,
              bottomY: 120,
            },
          ],
        },
      );

      const firstLine = measure.lines.at(0);
      expect(firstLine).toBeDefined();
      // After the skip, the line measures against the full 500px content
      // (no leftOffset/rightOffset attached). Without the skip, the
      // line would be ~15px wide and produce dozens of single-glyph rows.
      expect(firstLine?.rightOffset).toBeUndefined();
      expect(firstLine?.leftOffset).toBeUndefined();
      // The skip amount must reach or exceed the float's bottomY so the
      // line is now in clear vertical space.
      expect(firstLine?.floatSkipBefore).toBeGreaterThanOrEqual(120);
      // Total height includes the skip — containers must size correctly.
      expect(measure.totalHeight).toBeGreaterThanOrEqual(120);
    }, fakeMeasure);
  });

  // Regression: two floats stacked vertically, each on a different side,
  // together cover the entire row at the top. Per upstream #596 the line
  // must skip past *both* floats, not just the first.
  test("line is bumped past two stacked floats covering the row", () => {
    withFakeTextMeasure(() => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "p",
          runs: [{ kind: "text", text: "body text" }],
          attrs: { defaultFontSize: 11, defaultFontFamily: "Calibri" },
        },
        500,
        {
          floatingZones: [
            // Top float on the right — leaves ~10px on the left.
            {
              leftMargin: 0,
              rightMargin: 490,
              topY: 0,
              bottomY: 80,
            },
            // Stacked just below, on the left — also leaves ~10px on the right.
            {
              leftMargin: 490,
              rightMargin: 0,
              topY: 80,
              bottomY: 160,
            },
          ],
        },
      );

      const firstLine = measure.lines.at(0);
      expect(firstLine).toBeDefined();
      expect(firstLine?.floatSkipBefore).toBeGreaterThanOrEqual(160);
      expect(firstLine?.leftOffset).toBeUndefined();
      expect(firstLine?.rightOffset).toBeUndefined();
    }, fakeMeasure);
  });

  // Floats with adequate room next to them must NOT trigger a skip — the
  // line should wrap around them at the natural Y.
  test("float that still leaves usable width does not trigger a skip", () => {
    withFakeTextMeasure(() => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "p",
          runs: [{ kind: "text", text: "body text" }],
          attrs: { defaultFontSize: 11, defaultFontFamily: "Calibri" },
        },
        500,
        {
          floatingZones: [
            {
              leftMargin: 200,
              rightMargin: 0,
              topY: 0,
              bottomY: 80,
            },
          ],
        },
      );

      const firstLine = measure.lines.at(0);
      expect(firstLine).toBeDefined();
      expect(firstLine?.floatSkipBefore).toBeUndefined();
      // Float still applies — line is offset by 200px on the left.
      expect(firstLine?.leftOffset).toBe(200);
    }, fakeMeasure);
  });
});
