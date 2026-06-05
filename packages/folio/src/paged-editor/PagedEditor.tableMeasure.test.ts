import { describe, expect, test } from "bun:test";

import { clearAllCaches } from "../core/layout-engine/measure/cache";
import { resetCanvasContext } from "../core/layout-engine/measure/measureContainer";
import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  TextBoxBlock,
} from "../core/layout-engine/types";
import {
  measureBlocks,
  measureTableBlock,
  measureTableCellBlockVisualHeight,
} from "./PagedEditor";

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
                width: text.length * 5,
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

const imageOnlyParagraph: ParagraphBlock = {
  kind: "paragraph",
  id: "p-image",
  runs: [
    {
      kind: "image",
      src: "data:image/png;base64,",
      width: 186,
      height: 29,
    },
  ],
  attrs: {
    spacing: {
      before: 2,
      after: 3,
    },
  },
};

const imageParagraphMeasure: ParagraphMeasure = {
  kind: "paragraph",
  lines: [
    {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 0,
      width: 186,
      ascent: 30.921_875,
      descent: 6.078_125,
      lineHeight: 37,
    },
  ],
  totalHeight: 42,
};

describe("measureTableCellBlockVisualHeight", () => {
  test("uses actual image height for image-only table-cell paragraphs", () => {
    expect(
      measureTableCellBlockVisualHeight(
        imageOnlyParagraph,
        imageParagraphMeasure,
      ),
    ).toBe(34);
  });

  test("ignores visually empty text around image-only table-cell paragraphs", () => {
    const paragraph: ParagraphBlock = {
      ...imageOnlyParagraph,
      runs: [
        { kind: "text", text: " " },
        ...imageOnlyParagraph.runs,
        { kind: "text", text: "\u00a0" },
      ],
    };

    expect(
      measureTableCellBlockVisualHeight(paragraph, imageParagraphMeasure),
    ).toBe(34);
  });

  test("keeps measured paragraph height for mixed-content paragraphs", () => {
    const mixedParagraph: ParagraphBlock = {
      ...imageOnlyParagraph,
      runs: [{ kind: "text", text: "Caption" }, ...imageOnlyParagraph.runs],
    };

    expect(
      measureTableCellBlockVisualHeight(mixedParagraph, imageParagraphMeasure),
    ).toBe(42);
  });

  test("keeps measured paragraph height for floating image-only paragraphs", () => {
    const floatingImageParagraph: ParagraphBlock = {
      ...imageOnlyParagraph,
      runs: [
        {
          kind: "image",
          src: "data:image/png;base64,",
          width: 186,
          height: 90,
          displayMode: "float",
          wrapType: "square",
        },
      ],
    };
    const floatingParagraphMeasure: ParagraphMeasure = {
      kind: "paragraph",
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: 1,
          width: 0,
          ascent: 10,
          descent: 2,
          lineHeight: 12,
        },
      ],
      totalHeight: 12,
    };

    expect(
      measureTableCellBlockVisualHeight(
        floatingImageParagraph,
        floatingParagraphMeasure,
      ),
    ).toBe(12);
  });

  test("keeps measured paragraph height for block image-only paragraphs", () => {
    const blockImageParagraph: ParagraphBlock = {
      ...imageOnlyParagraph,
      runs: [
        {
          kind: "image",
          src: "data:image/png;base64,",
          width: 186,
          height: 90,
          displayMode: "block",
          wrapType: "topAndBottom",
          distTop: 8,
          distBottom: 6,
        },
      ],
    };
    const blockParagraphMeasure: ParagraphMeasure = {
      kind: "paragraph",
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: 1,
          width: 186,
          ascent: 96,
          descent: 8,
          lineHeight: 104,
        },
      ],
      totalHeight: 104,
    };

    expect(
      measureTableCellBlockVisualHeight(
        blockImageParagraph,
        blockParagraphMeasure,
      ),
    ).toBe(104);
  });

  test("uses totalHeight for non-paragraph block measures", () => {
    const block: FlowBlock = {
      kind: "table",
      id: "nested",
      rows: [],
    };
    const measure: Measure = {
      kind: "table",
      rows: [],
      columnWidths: [],
      totalWidth: 10,
      totalHeight: 22,
    };

    expect(measureTableCellBlockVisualHeight(block, measure)).toBe(22);
  });
});

describe("measureBlocks floating text-box bands", () => {
  test("activates a margin-pinned band at its real text-box anchor", () => {
    withFakeTextMeasure(() => {
      const before: ParagraphBlock = {
        kind: "paragraph",
        id: "before",
        runs: [{ kind: "text", text: "before" }],
      };
      const band: TextBoxBlock = {
        kind: "textBox",
        id: "band",
        width: 300,
        height: 120,
        content: [],
        wrapType: "topAndBottom",
        position: { vertical: { relativeTo: "margin", posOffset: 0 } },
      };
      const after: ParagraphBlock = {
        kind: "paragraph",
        id: "after",
        runs: [{ kind: "text", text: "after" }],
      };

      const measures = measureBlocks([before, band, after], 500, 96);
      const beforeMeasure = measures.at(0);
      const afterMeasure = measures.at(2);

      expect(beforeMeasure?.kind).toBe("paragraph");
      expect(afterMeasure?.kind).toBe("paragraph");
      if (beforeMeasure?.kind !== "paragraph") {
        throw new Error("Expected first paragraph measure");
      }
      if (afterMeasure?.kind !== "paragraph") {
        throw new Error("Expected second paragraph measure");
      }
      // The band activates at its real anchor: `before` (above the anchor) is
      // not pushed down.
      expect(beforeMeasure.totalHeight).toBeLessThan(50);
      // `after` clears the band from the real cursor, not from the page top: it
      // is pushed only by the band remaining below `before`, landing exactly at
      // the band bottom (floatSkipBefore + before height = band height = 120).
      // A full-band skip here would open a blank gap. eigenpal #694.
      const skip = afterMeasure.lines.at(0)?.floatSkipBefore ?? 0;
      expect(skip).toBeGreaterThan(0);
      expect(skip + beforeMeasure.totalHeight).toBeCloseTo(120, 5);
    });
  });

  test("a tall block before the anchor leaves no band skip (no blank gap)", () => {
    withFakeTextMeasure(() => {
      // `before` is taller than the band bottom, so the cursor is already below
      // the band when `after` is reached: it must not be pushed down again.
      const before: ParagraphBlock = {
        kind: "paragraph",
        id: "before",
        runs: [{ kind: "text", text: "tall ".repeat(400).trim() }],
      };
      const band: TextBoxBlock = {
        kind: "textBox",
        id: "band",
        width: 300,
        height: 60,
        content: [],
        wrapType: "topAndBottom",
        position: { vertical: { relativeTo: "margin", posOffset: 0 } },
      };
      const after: ParagraphBlock = {
        kind: "paragraph",
        id: "after",
        runs: [{ kind: "text", text: "after" }],
      };

      const measures = measureBlocks([before, band, after], 200, 96);
      const beforeMeasure = measures.at(0);
      const afterMeasure = measures.at(2);

      if (
        beforeMeasure?.kind !== "paragraph" ||
        afterMeasure?.kind !== "paragraph"
      ) {
        throw new Error("Expected paragraph measures around the band");
      }
      expect(beforeMeasure.totalHeight).toBeGreaterThan(60);
      expect(afterMeasure.lines.at(0)?.floatSkipBefore ?? 0).toBe(0);
    });
  });

  test("reserves measured height for auto-height bands", () => {
    withFakeTextMeasure(() => {
      const band: TextBoxBlock = {
        kind: "textBox",
        id: "band",
        width: 300,
        content: [
          {
            kind: "paragraph",
            id: "band-content",
            runs: [{ kind: "text", text: "banner" }],
          },
        ],
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        wrapType: "topAndBottom",
        position: { vertical: { relativeTo: "margin", posOffset: 0 } },
      };
      const after: ParagraphBlock = {
        kind: "paragraph",
        id: "after",
        runs: [{ kind: "text", text: "after" }],
      };

      const measures = measureBlocks([band, after], 500, 96);
      const bandMeasure = measures.at(0);
      const afterMeasure = measures.at(1);

      expect(bandMeasure?.kind).toBe("textBox");
      expect(afterMeasure?.kind).toBe("paragraph");
      if (bandMeasure?.kind !== "textBox") {
        throw new Error("Expected text box measure");
      }
      if (afterMeasure?.kind !== "paragraph") {
        throw new Error("Expected paragraph measure");
      }
      expect(bandMeasure.height).toBeGreaterThan(0);
      expect(afterMeasure.lines.at(0)?.floatSkipBefore).toBeGreaterThanOrEqual(
        bandMeasure.height,
      );
    });
  });

  test("uses the current section top margin for page-pinned bands", () => {
    withFakeTextMeasure(() => {
      const before: ParagraphBlock = {
        kind: "paragraph",
        id: "before",
        runs: [{ kind: "text", text: "before" }],
      };
      const band: TextBoxBlock = {
        kind: "textBox",
        id: "band",
        width: 300,
        height: 200,
        content: [],
        wrapType: "topAndBottom",
        position: { vertical: { relativeTo: "page", posOffset: 0 } },
      };
      const after: ParagraphBlock = {
        kind: "paragraph",
        id: "after",
        runs: [{ kind: "text", text: "after" }],
      };

      const measures = measureBlocks(
        [before, band, after],
        [500, 500, 500],
        [96, 144, 144],
      );
      const beforeMeasure = measures.at(0);
      const afterMeasure = measures.at(2);

      expect(beforeMeasure?.kind).toBe("paragraph");
      expect(afterMeasure?.kind).toBe("paragraph");
      if (beforeMeasure?.kind !== "paragraph") {
        throw new Error("Expected paragraph measure before band");
      }
      if (afterMeasure?.kind !== "paragraph") {
        throw new Error("Expected paragraph measure after band");
      }
      // The band bottom sits at 56 in content coords: page-relative offset 0
      // resolves to `bandHeight - sectionMarginTop = 200 - 144`. The 96px first
      // section margin must not leak in (that would yield 200 - 96 = 104).
      // `before` already occupies the top of the page, so `after` is pushed down
      // only by the remaining band below the cursor and lands exactly at the band
      // bottom: floatSkipBefore + before height = 56. eigenpal #694.
      const skip = afterMeasure.lines.at(0)?.floatSkipBefore ?? 0;
      expect(skip).toBeGreaterThan(0);
      expect(skip + beforeMeasure.totalHeight).toBeCloseTo(56, 5);
    });
  });

  test("two bands sharing a topY each anchor to their own text box", () => {
    withFakeTextMeasure(() => {
      // Both bands are margin-pinned at offset 0 (same topY), but they pin to
      // different text boxes. The second band must not be regrouped onto the
      // first band's anchor, or `mid` (between them) would reserve the taller
      // second band that is painted later. eigenpal #694.
      const bandA: TextBoxBlock = {
        kind: "textBox",
        id: "band-a",
        width: 300,
        height: 60,
        content: [],
        wrapType: "topAndBottom",
        position: { vertical: { relativeTo: "margin", posOffset: 0 } },
      };
      const mid: ParagraphBlock = {
        kind: "paragraph",
        id: "mid",
        runs: [{ kind: "text", text: "mid" }],
      };
      const bandB: TextBoxBlock = {
        kind: "textBox",
        id: "band-b",
        width: 300,
        height: 200,
        content: [],
        wrapType: "topAndBottom",
        position: { vertical: { relativeTo: "margin", posOffset: 0 } },
      };
      const after: ParagraphBlock = {
        kind: "paragraph",
        id: "after",
        runs: [{ kind: "text", text: "after" }],
      };

      const measures = measureBlocks([bandA, mid, bandB, after], 500, 96);
      const midMeasure = measures.at(1);
      const afterMeasure = measures.at(3);

      if (
        midMeasure?.kind !== "paragraph" ||
        afterMeasure?.kind !== "paragraph"
      ) {
        throw new Error("Expected paragraph measures around the bands");
      }
      // `mid` clears only the first band (60), not the second band's 200; the
      // bug regrouped both onto bandA's anchor and reserved ~200 here.
      expect(midMeasure.lines.at(0)?.floatSkipBefore).toBeCloseTo(60, 5);
      // The second band still reserves space at its own anchor.
      expect(afterMeasure.lines.at(0)?.floatSkipBefore ?? 0).toBeGreaterThan(0);
    });
  });
});

describe("measureTableBlock", () => {
  test("does not inflate image-only cells by paragraph line-height", () => {
    const tableMeasure = measureTableBlock(
      {
        kind: "table",
        id: "table",
        rows: [
          {
            id: "row",
            cells: [
              {
                id: "cell",
                blocks: [imageOnlyParagraph],
                padding: {
                  top: 1,
                  bottom: 1,
                  left: 0,
                  right: 0,
                },
              },
            ],
          },
        ],
      },
      300,
    );

    expect(tableMeasure.rows[0]?.height).toBeCloseTo(36, 1);
  });

  // Regression eigenpal #424 gap 14: `w:noWrap` must be honored during the
  // measurement phase, not only as a `white-space: nowrap` paint hint. The
  // paragraph line breaker runs against the cell's pixel width and emits one
  // MeasuredLine per visual line, which the painter renders as stacked divs.
  // Without measure-time honoring of noWrap, a long case number in a narrow
  // column still rendered on multiple rows even though the cell box had
  // `white-space: nowrap` applied.
  describe("w:noWrap cells (eigenpal #424 gap 14)", () => {
    const longSentence: ParagraphBlock = {
      kind: "paragraph",
      id: "p-long",
      runs: [
        {
          kind: "text",
          text: "This sentence is intentionally long enough to wrap across multiple lines inside a narrow column.",
        },
      ],
    };

    test("measures wrapping cells with multiple MeasuredLines", () => {
      withFakeTextMeasure(() => {
        const tableMeasure = measureTableBlock(
          {
            kind: "table",
            id: "table",
            rows: [
              {
                id: "row",
                cells: [
                  {
                    id: "cell",
                    blocks: [longSentence],
                    padding: { top: 0, right: 0, bottom: 0, left: 0 },
                  },
                ],
              },
            ],
            columnWidths: [80],
          },
          500,
        );

        const blockMeasure = tableMeasure.rows[0]?.cells[0]?.blocks[0];
        if (blockMeasure?.kind !== "paragraph") {
          throw new Error("Expected paragraph measure");
        }
        expect(blockMeasure.lines.length).toBeGreaterThan(1);
      });
    });

    test("collapses noWrap cells to a single MeasuredLine even in a narrow column", () => {
      withFakeTextMeasure(() => {
        const tableMeasure = measureTableBlock(
          {
            kind: "table",
            id: "table",
            rows: [
              {
                id: "row",
                cells: [
                  {
                    id: "cell",
                    blocks: [longSentence],
                    padding: { top: 0, right: 0, bottom: 0, left: 0 },
                    noWrap: true,
                  },
                ],
              },
            ],
            columnWidths: [80],
          },
          500,
        );

        const blockMeasure = tableMeasure.rows[0]?.cells[0]?.blocks[0];
        if (blockMeasure?.kind !== "paragraph") {
          throw new Error("Expected paragraph measure");
        }
        expect(blockMeasure.lines.length).toBe(1);
      });
    });
  });
});
