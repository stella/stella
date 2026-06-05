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
      expect(beforeMeasure.totalHeight).toBeLessThan(50);
      expect(afterMeasure.totalHeight).toBeGreaterThanOrEqual(120);
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
      const afterMeasure = measures.at(2);

      expect(afterMeasure?.kind).toBe("paragraph");
      if (afterMeasure?.kind !== "paragraph") {
        throw new Error("Expected paragraph measure after band");
      }
      expect(afterMeasure.lines.at(0)?.floatSkipBefore).toBe(56);
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
