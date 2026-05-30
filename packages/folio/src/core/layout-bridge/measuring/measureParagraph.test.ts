import { describe, expect, test } from "bun:test";

import { clearAllCaches, hashParagraphBlock } from "./cache";
import {
  buildFontString,
  getFontMetrics,
  measureTextWidth,
  resetCanvasContext,
} from "./measureContainer";
import {
  clampFloatingWrapMargins,
  getRunCharWidths,
  measureParagraph,
} from "./measureParagraph";

const PT_TO_PX = 96 / 72;

function withFakeTextMeasure(
  runTest: (getMeasureCount: () => number) => void,
): void {
  const originalDocument = globalThis.document;
  let measureCount = 0;
  const fakeDocument = {
    createElement() {
      return {
        getContext() {
          return {
            font: "",
            measureText(this: { font: string }, text: string) {
              measureCount += 1;
              let width = 0;
              const isSmallCaps = this.font.includes("small-caps");
              for (const char of text) {
                const isUppercase = char >= "A" && char <= "Z";
                const isLowercase = char >= "a" && char <= "z";
                if (isUppercase) {
                  width += 10;
                } else if (isSmallCaps && isLowercase) {
                  width += 8;
                } else {
                  width += 5;
                }
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
    runTest(() => measureCount);
  } finally {
    resetCanvasContext();
    clearAllCaches();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
}

describe("text measurement cache", () => {
  test("reuses canvas text width measurements for identical text and style", () => {
    withFakeTextMeasure((getMeasureCount) => {
      const style = { fontFamily: "Arial", fontSize: 11 };

      expect(measureTextWidth("Repeated legal text", style)).toBe(
        measureTextWidth("Repeated legal text", style),
      );
      expect(getMeasureCount()).toBe(1);
    });
  });

  test("keeps horizontal scale in the text width cache key", () => {
    withFakeTextMeasure((getMeasureCount) => {
      const text = "scaled";
      const normalWidth = measureTextWidth(text, {
        fontFamily: "Arial",
        fontSize: 11,
      });
      const scaledWidth = measureTextWidth(text, {
        fontFamily: "Arial",
        fontSize: 11,
        horizontalScale: 150,
      });

      expect(scaledWidth).toBe(normalWidth * 1.5);
      expect(getMeasureCount()).toBe(2);
    });
  });
});

describe("font metrics cache", () => {
  test("reuses canvas font metrics for identical font styles", () => {
    withFakeTextMeasure((getMeasureCount) => {
      const style = { fontFamily: "Arial", fontSize: 11 };

      expect(getFontMetrics(style)).toEqual(getFontMetrics(style));
      expect(getMeasureCount()).toBe(1);
    });
  });

  test("keeps font variant in the metrics cache key", () => {
    withFakeTextMeasure((getMeasureCount) => {
      getFontMetrics({ fontFamily: "Arial", fontSize: 11 });
      getFontMetrics({
        fontFamily: "Arial",
        fontSize: 11,
        fontVariant: "small-caps",
      });

      expect(getMeasureCount()).toBe(2);
    });
  });
});

describe("empty paragraph line-height floor", () => {
  test("empty paragraph with line=1.0 auto is floored to 1.15 times fontSize", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "t1",
        pmStart: 0,
        pmEnd: 0,
        runs: [],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Arial Narrow",
          spacing: { line: 1, lineUnit: "multiplier", lineRule: "auto" },
        },
      },
      600,
    );

    expect(measure.totalHeight).toBeCloseTo(11 * PT_TO_PX * 1.15, 1);
  });

  test("empty paragraph with lineRule=exact is not floored", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "t2",
        pmStart: 0,
        pmEnd: 0,
        runs: [],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Arial Narrow",
          spacing: { line: 8, lineUnit: "px", lineRule: "exact" },
        },
      },
      600,
    );

    expect(measure.totalHeight).toBeCloseTo(8, 1);
  });

  test("empty paragraph includes authored spacing", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "t3",
        pmStart: 0,
        pmEnd: 0,
        runs: [],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Arial Narrow",
          spacing: {
            before: 5,
            after: 7,
            line: 1,
            lineUnit: "multiplier",
            lineRule: "auto",
          },
        },
      },
      600,
    );

    expect(measure.totalHeight).toBeCloseTo(11 * PT_TO_PX * 1.15 + 12, 1);
  });

  for (const text of ["", " ", "\u00a0"]) {
    test(`visually empty single text run ${JSON.stringify(text)} includes authored spacing`, () => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "t3-text-run",
          pmStart: 0,
          pmEnd: 0,
          runs: [{ kind: "text", text }],
          attrs: {
            defaultFontSize: 11,
            defaultFontFamily: "Arial Narrow",
            spacing: {
              before: 5,
              after: 7,
              line: 1,
              lineUnit: "multiplier",
              lineRule: "auto",
            },
          },
        },
        600,
      );

      expect(measure.lines).toHaveLength(1);
      expect(measure.totalHeight).toBeCloseTo(
        (measure.lines[0]?.lineHeight ?? 0) + 12,
        1,
      );
    });
  }

  test("suppressed empty paragraph keeps a zero-height anchor", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "t4",
        pmStart: 0,
        pmEnd: 0,
        runs: [],
        attrs: {
          suppressEmptyParagraphHeight: true,
          defaultFontSize: 11,
          defaultFontFamily: "Arial Narrow",
        },
      },
      600,
    );

    expect(measure.totalHeight).toBe(0);
    expect(measure.lines[0]?.lineHeight).toBe(0);
  });
});

describe("inline image paragraph measurement", () => {
  test("image-only line reserves descender room above and below image", () => {
    const imageHeight = 29;
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "img1",
        pmStart: 0,
        pmEnd: 1,
        runs: [
          {
            kind: "image",
            src: "data:image/png;base64,",
            width: 186,
            height: imageHeight,
            pmStart: 0,
            pmEnd: 1,
          },
        ],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Calibri",
        },
      },
      600,
    );

    expect(measure.lines[0]?.lineHeight).toBeGreaterThan(imageHeight);
    expect(measure.lines[0]?.ascent).toBeGreaterThan(imageHeight);
    expect(measure.lines[0]?.descent).toBeGreaterThan(0);
  });

  test("advances floating-zone y offsets by image-inflated line height", () => {
    withFakeTextMeasure(() => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "img-float",
          runs: [
            {
              kind: "image",
              src: "data:image/png;base64,",
              width: 35,
              height: 90,
            },
            { kind: "text", text: "iiii" },
          ],
        },
        40,
        {
          floatingZones: [
            {
              leftMargin: 35,
              rightMargin: 0,
              topY: 20,
              bottomY: 80,
            },
          ],
        },
      );

      expect(measure.lines).toHaveLength(2);
      expect(measure.lines.at(1)?.leftOffset).toBeUndefined();
      expect(measure.lines.at(1)?.width).toBe(20);
    });
  });

  // Regression: a logo + label header line (image flowing alongside text) used
  // to inherit the image-only branch's `imageH + descent*2` line box, which
  // centered the text inside an inflated band and left it floating above the
  // paragraph border (eigenpal #580). Word baseline-aligns the row and sizes
  // the line as `imageH + text descent`.
  test("image-with-text line sizes as imageH + text descent (baseline-aligned)", () => {
    withFakeTextMeasure(() => {
      const imageHeight = 40;
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "logo-label",
          runs: [
            {
              kind: "image",
              src: "data:image/png;base64,",
              width: 80,
              height: imageHeight,
            },
            { kind: "text", text: "Header" },
          ],
        },
        600,
      );

      const line = measure.lines.at(0);
      expect(line).toBeDefined();
      // Line height should equal imageH + a single descent buffer; the
      // image-alone branch would emit imageH + descent*2, so check that the
      // height is strictly less than that.
      const descent = line?.descent ?? 0;
      expect(descent).toBeGreaterThan(0);
      expect(line?.lineHeight).toBe(imageHeight + descent);
      expect(line?.ascent).toBe(imageHeight);
    });
  });

  test("image-only line keeps imageH + descent*2 breathing-room band", () => {
    const imageHeight = 40;
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "logo-alone",
        runs: [
          {
            kind: "image",
            src: "data:image/png;base64,",
            width: 80,
            height: imageHeight,
          },
        ],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Calibri",
        },
      },
      600,
    );

    const line = measure.lines.at(0);
    expect(line).toBeDefined();
    const descent = line?.descent ?? 0;
    expect(line?.lineHeight).toBe(imageHeight + descent * 2);
    expect(line?.ascent).toBe(imageHeight + descent);
  });

  test("inline image footprint includes its wp:inline distT/distB", () => {
    withFakeTextMeasure(() => {
      // distTop/distBottom = 8 each = 16px of extra footprint; the line
      // height must reserve that or the painter's per-image margin spills
      // past the line's reserved height.
      const imageHeight = 20;
      const distTop = 8;
      const distBottom = 8;
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "logo-dist",
          runs: [
            {
              kind: "image",
              src: "data:image/png;base64,",
              width: 80,
              height: imageHeight,
              distTop,
              distBottom,
            },
            { kind: "text", text: "Header" },
          ],
        },
        600,
      );

      const line = measure.lines.at(0);
      expect(line).toBeDefined();
      const descent = line?.descent ?? 0;
      // Footprint = imageHeight + distTop + distBottom; the image-with-text
      // branch adds a single descent buffer below baseline.
      expect(line?.lineHeight).toBe(
        imageHeight + distTop + distBottom + descent,
      );
    });
  });

  // Regression: a 100×200 inline image rotated 90° should reserve a 200×100
  // axis-aligned bbox in the measurer, matching the painter's wrapper span
  // (eigenpal #424 follow-up; gemini/codex review on PR 518). Without this,
  // following text wrapped too early horizontally and the next line could
  // overlap vertically.
  test("rotated inline image reserves its bbox width on the line", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "img-rot-w",
        runs: [
          {
            kind: "image",
            src: "data:image/png;base64,",
            width: 100,
            height: 200,
            transform: "rotate(90deg)",
          },
        ],
      },
      600,
    );

    const line = measure.lines.at(0);
    expect(line).toBeDefined();
    // bbox width = 200 (swapped from 100×200). The raw run.width would be 100.
    expect(line?.width).toBe(200);
  });

  test("rotated inline image reserves its bbox height on the line", () => {
    const imageWidth = 200;
    const imageHeight = 100;
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "img-rot-h",
        runs: [
          {
            kind: "image",
            src: "data:image/png;base64,",
            width: imageWidth,
            height: imageHeight,
            transform: "rotate(90deg)",
          },
        ],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Calibri",
        },
      },
      600,
    );

    const line = measure.lines.at(0);
    expect(line).toBeDefined();
    // bbox height = imageWidth (swapped). With the previous bug the line
    // would reserve `imageHeight` (100), which is shorter than the painted
    // bbox (200) and would let the next line overlap the rotated picture.
    expect(line?.ascent).toBeGreaterThanOrEqual(imageWidth);
  });

  test("rotated portrait→landscape inline image wraps onto a new line when bbox exceeds availableWidth", () => {
    withFakeTextMeasure(() => {
      // Container width 150; raw run.width = 100 would fit, but the rotated
      // bbox width = 200 should force a wrap onto its own line.
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "img-rot-wrap",
          runs: [
            { kind: "text", text: "x" },
            {
              kind: "image",
              src: "data:image/png;base64,",
              width: 100,
              height: 200,
              transform: "rotate(90deg)",
            },
          ],
        },
        150,
      );

      // Two lines: leading text on one, the rotated image alone on the next.
      expect(measure.lines.length).toBeGreaterThanOrEqual(2);
      expect(measure.lines.at(-1)?.width).toBe(200);
    });
  });

  test("inline image with no rotation keeps raw width on the line", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "img-no-rot",
        runs: [
          {
            kind: "image",
            src: "data:image/png;base64,",
            width: 100,
            height: 200,
          },
        ],
      },
      600,
    );

    const line = measure.lines.at(0);
    expect(line).toBeDefined();
    expect(line?.width).toBe(100);
  });
});

describe("block image rotation measurement", () => {
  // The painter wraps a rotated block image in an axis-aligned bbox
  // (`renderBlockImage`, eigenpal #424). The measurer has to reserve the
  // same rotated bbox height; otherwise the painter's container overflows
  // the line box and the next paragraph paints on top of the rotated
  // landscape image (codex PR #521 review).
  test("rotated block image reserves the rotated bbox height (270deg landscape)", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "rot-block",
        pmStart: 0,
        pmEnd: 1,
        runs: [
          {
            kind: "image",
            src: "data:image/png;base64,",
            width: 120,
            height: 60,
            displayMode: "block",
            transform: "rotate(270deg)",
            distTop: 6,
            distBottom: 6,
          },
        ],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Calibri",
        },
      },
      600,
    );

    // Rotated bbox of 120x60 at 270deg is 60x120: reserve the 120px
    // rotated height plus the default 6+6 margins, not the intrinsic
    // 60px height the un-rotated path used.
    expect(measure.lines[0]?.lineHeight).toBeGreaterThanOrEqual(120 + 12);
  });

  test("un-rotated block image still reserves the intrinsic height", () => {
    const measure = measureParagraph(
      {
        kind: "paragraph",
        id: "noop-block",
        pmStart: 0,
        pmEnd: 1,
        runs: [
          {
            kind: "image",
            src: "data:image/png;base64,",
            width: 120,
            height: 60,
            displayMode: "block",
            distTop: 6,
            distBottom: 6,
          },
        ],
        attrs: {
          defaultFontSize: 11,
          defaultFontFamily: "Calibri",
        },
      },
      600,
    );

    expect(measure.lines[0]?.lineHeight).toBeGreaterThanOrEqual(60 + 12);
    expect(measure.lines[0]?.lineHeight).toBeLessThan(120);
  });
});

describe("paragraph indentation measurement", () => {
  test("negative side indents widen the measured line box", () => {
    withFakeTextMeasure(() => {
      const block = {
        kind: "paragraph" as const,
        id: "negative-indent",
        runs: [
          {
            kind: "text" as const,
            text: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
            fontSize: 11,
          },
        ],
        attrs: {
          indent: {
            left: -20,
            right: -10,
          },
        },
      };

      expect(measureParagraph(block, 100).lines).toHaveLength(1);
    });
  });
});

describe("all-caps paragraph measurement", () => {
  test("builds canvas font strings with the rendered DOCX bold weight", () => {
    const font = buildFontString({
      fontFamily: "Arial",
      fontSize: 12,
      bold: true,
    });

    expect(font).toContain("800");
    expect(font).not.toContain("bold");
  });

  test("measures all-caps runs using uppercase glyph widths", () => {
    withFakeTextMeasure(() => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "caps",
          runs: [{ kind: "text", text: "iiii", allCaps: true }],
        },
        25,
      );

      expect(measure.lines).toHaveLength(2);
    });
  });

  test("measures horizontally scaled runs using scaled glyph widths", () => {
    withFakeTextMeasure(() => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "scaled",
          runs: [{ kind: "text", text: "iiii", horizontalScale: 150 }],
        },
        25,
      );

      expect(measure.lines).toHaveLength(2);
    });
  });

  test("measures small-caps runs using small-caps glyph widths", () => {
    withFakeTextMeasure(() => {
      const measure = measureParagraph(
        {
          kind: "paragraph",
          id: "small-caps",
          runs: [{ kind: "text", text: "iiii", smallCaps: true }],
        },
        25,
      );

      expect(measure.lines).toHaveLength(2);
      expect(
        getRunCharWidths({ kind: "text", text: "ii", smallCaps: true }),
      ).toEqual([8, 8]);
    });
  });

  test("includes small-caps formatting in paragraph cache keys", () => {
    const plainHash = hashParagraphBlock({
      kind: "paragraph",
      id: "plain",
      runs: [{ kind: "text", text: "iiii" }],
    });
    const smallCapsHash = hashParagraphBlock({
      kind: "paragraph",
      id: "small-caps",
      runs: [{ kind: "text", text: "iiii", smallCaps: true }],
    });

    expect(smallCapsHash).not.toBe(plainHash);
  });

  test("includes character spacing in paragraph cache keys", () => {
    const plainHash = hashParagraphBlock({
      kind: "paragraph",
      id: "plain",
      runs: [{ kind: "text", text: "iiii" }],
    });
    const spacedHash = hashParagraphBlock({
      kind: "paragraph",
      id: "spaced",
      runs: [{ kind: "text", text: "iiii", letterSpacing: 1.5 }],
    });

    expect(spacedHash).not.toBe(plainHash);
  });
});

describe("clampFloatingWrapMargins", () => {
  // A near-full-width floating table or image computes a left/right wrap
  // margin that extends past contentWidth (margins are `rectRight` or
  // `contentWidth - (x - distLeft)`, both of which can spill). Without
  // clamping, getFloatingMargins propagates that margin into the line and
  // measureParagraph collapses every wrapped line to ~1 glyph wide — the
  // "single character per line after a wide float" symptom.
  test("zeros margins that exceed content width", () => {
    expect(clampFloatingWrapMargins(698, 0, 671)).toEqual({
      leftMargin: 0,
      rightMargin: 0,
    });
    expect(clampFloatingWrapMargins(0, 700, 671)).toEqual({
      leftMargin: 0,
      rightMargin: 0,
    });
  });

  test("zeros when combined side margins cover the content area", () => {
    expect(clampFloatingWrapMargins(400, 300, 671)).toEqual({
      leftMargin: 0,
      rightMargin: 0,
    });
  });

  test("preserves valid one-sided margins", () => {
    expect(clampFloatingWrapMargins(200, 0, 671)).toEqual({
      leftMargin: 200,
      rightMargin: 0,
    });
    expect(clampFloatingWrapMargins(0, 150, 671)).toEqual({
      leftMargin: 0,
      rightMargin: 150,
    });
  });

  test("clamps negative inputs to 0", () => {
    expect(clampFloatingWrapMargins(-5, -10, 671)).toEqual({
      leftMargin: 0,
      rightMargin: 0,
    });
  });

  test("falls back to contentWidth=1 floor for non-positive contentWidth", () => {
    expect(clampFloatingWrapMargins(0, 0, 0)).toEqual({
      leftMargin: 0,
      rightMargin: 0,
    });
  });
});
