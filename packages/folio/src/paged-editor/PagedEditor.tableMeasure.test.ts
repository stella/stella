import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
} from "../core/layout-engine/types";
import {
  measureTableBlock,
  measureTableCellBlockVisualHeight,
} from "./PagedEditor";

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
});
