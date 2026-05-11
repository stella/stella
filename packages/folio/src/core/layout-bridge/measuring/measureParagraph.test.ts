import { describe, expect, test } from "bun:test";

import { hashParagraphBlock } from "./cache";
import { buildFontString, resetCanvasContext } from "./measureContainer";
import { getRunCharWidths, measureParagraph } from "./measureParagraph";

const PT_TO_PX = 96 / 72;

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
