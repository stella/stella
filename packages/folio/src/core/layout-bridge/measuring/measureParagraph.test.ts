import { describe, expect, test } from "bun:test";

import { measureParagraph } from "./measureParagraph";

const PT_TO_PX = 96 / 72;

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
});
