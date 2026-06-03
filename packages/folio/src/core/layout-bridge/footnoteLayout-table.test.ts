import { describe, expect, test } from "bun:test";

import { resetCanvasContext } from "../layout-engine/measure/measureContainer";
import type { FlowBlock } from "../layout-engine/types";
import type { Footnote } from "../types/document";
import {
  applyFootnotePresentation,
  convertFootnoteToContent,
} from "./footnoteLayout";

const footnoteWithTable: Footnote = {
  type: "footnote",
  id: 7,
  noteType: "normal",
  content: [
    {
      type: "paragraph",
      content: [{ type: "run", content: [{ type: "text", text: "Intro" }] }],
    },
    {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "Cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const emptyFootnoteWithTable: Footnote = {
  type: "footnote",
  id: 8,
  noteType: "normal",
  content: [
    {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [] }],
            },
          ],
        },
      ],
    },
  ],
};

const footnoteWithBlockSdt: Footnote = {
  type: "footnote",
  id: 10,
  noteType: "normal",
  content: [
    {
      type: "blockSdt",
      properties: {
        tag: "cite",
        alias: "Citation",
      },
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "run",
              content: [{ type: "text", text: "Smith v Jones" }],
            },
          ],
        },
      ],
    },
  ],
};

const footnoteWithRowSpanTable: Footnote = {
  type: "footnote",
  id: 9,
  noteType: "normal",
  content: [
    {
      type: "table",
      columnWidths: [1440, 2880],
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              formatting: { vMerge: "restart" },
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "A" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "B" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              formatting: { vMerge: "continue" },
              content: [{ type: "paragraph", content: [] }],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "C" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

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

describe("footnote layout", () => {
  test("routes footnotes through the body pipeline so tables survive", () => {
    const content = convertFootnoteToContent(footnoteWithTable, 3, 400, {
      measureBlocks(blocks) {
        return blocks.map((block) =>
          block.kind === "table"
            ? {
                kind: "table",
                rows: [],
                columnWidths: [400],
                totalWidth: 400,
                totalHeight: 24,
              }
            : { kind: "paragraph", lines: [], totalHeight: 12 },
        );
      },
    });

    expect(content.blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "table",
    ]);
    expect(content.height).toBe(36);
  });

  test("renders paragraphs nested inside footnote block SDTs", () => {
    const content = convertFootnoteToContent(footnoteWithBlockSdt, 10, 400, {
      measureBlocks(blocks) {
        return blocks.map(() => ({
          kind: "paragraph",
          lines: [],
          totalHeight: 12,
        }));
      },
    });

    expect(content.blocks).toHaveLength(1);
    const paragraph = content.blocks.at(0);
    expect(paragraph?.kind).toBe("paragraph");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected footnote SDT to produce a paragraph");
    }

    expect(paragraph.runs.at(1)).toMatchObject({
      kind: "text",
      text: "Smith v Jones",
    });
    expect(paragraph.sdtGroups?.at(0)).toMatchObject({
      tag: "cite",
      alias: "Citation",
    });
  });

  test("measures table footnotes without a caller-provided measurement hook", () => {
    withFakeTextMeasure(() => {
      const content = convertFootnoteToContent(emptyFootnoteWithTable, 3, 400);

      expect(content.blocks.map((block) => block.kind)).toEqual([
        "paragraph",
        "table",
      ]);
      expect(Number.isNaN(content.height)).toBe(false);
      expect(content.height).toBeGreaterThan(0);

      const numberBlock = content.blocks.at(0);
      expect(numberBlock?.kind).toBe("paragraph");
      if (numberBlock?.kind !== "paragraph") {
        throw new Error("Expected footnote number paragraph");
      }
      expect(numberBlock.runs.at(0)).toMatchObject({
        kind: "text",
        text: "3  ",
        superscript: true,
      });

      const tableMeasure = content.measures.at(1);
      expect(tableMeasure?.kind).toBe("table");
      if (tableMeasure?.kind !== "table") {
        throw new Error("Expected footnote table to have a table measure");
      }
      expect(tableMeasure.totalHeight).toBeGreaterThan(0);
    });
  });

  test("skips row-spanned columns while measuring footnote table rows", () => {
    withFakeTextMeasure(() => {
      const content = convertFootnoteToContent(
        footnoteWithRowSpanTable,
        4,
        400,
      );
      const tableMeasure = content.measures.at(1);

      expect(tableMeasure?.kind).toBe("table");
      if (tableMeasure?.kind !== "table") {
        throw new Error("Expected footnote table to have a table measure");
      }

      expect(tableMeasure.rows.at(0)?.cells.at(0)?.rowSpan).toBe(2);
      expect(tableMeasure.rows.at(0)?.cells.at(0)?.width).toBeCloseTo(96);
      expect(tableMeasure.rows.at(1)?.cells.at(0)?.width).toBeCloseTo(192);
    });
  });

  test("applies footnote font size to nested table paragraphs and field runs", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "table",
        id: "table-1",
        rows: [
          {
            id: "row-1",
            cells: [
              {
                id: "cell-1",
                blocks: [
                  {
                    kind: "paragraph",
                    id: "cell-p-1",
                    runs: [
                      { kind: "text", text: "Cell" },
                      { kind: "field", fieldType: "PAGE", fallback: "1" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const table = applyFootnotePresentation(blocks, 4).at(1);
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") {
      throw new Error("Expected a table block");
    }

    const paragraph = table.rows.at(0)?.cells.at(0)?.blocks.at(0);
    expect(paragraph?.kind).toBe("paragraph");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected nested paragraph block");
    }

    expect(paragraph.runs.at(0)?.fontSize).toBe(8);
    expect(paragraph.runs.at(1)?.fontSize).toBe(8);
  });

  test("matches footnote number typography to the first footnote text run", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "footnote-text",
        runs: [
          {
            kind: "text",
            text: " Insert the name of the legal entity.",
            fontFamily: "Times New Roman",
            fontSize: 10,
          },
        ],
        attrs: {
          defaultFontFamily: "Times New Roman",
          defaultFontSize: 10,
        },
      },
    ];

    const paragraph = applyFootnotePresentation(blocks, 8).at(0);
    expect(paragraph?.kind).toBe("paragraph");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected a paragraph block");
    }

    expect(paragraph.runs.at(0)).toMatchObject({
      kind: "text",
      text: "8",
      fontFamily: "Times New Roman",
      fontSize: 10,
      superscript: true,
    });
  });

  test("adds one separator space when footnote text has no leading space", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "footnote-text",
        runs: [
          {
            kind: "text",
            text: "Footnote text",
            fontFamily: "Times New Roman",
            fontSize: 10,
          },
        ],
      },
    ];

    const paragraph = applyFootnotePresentation(blocks, 8).at(0);
    expect(paragraph?.kind).toBe("paragraph");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected a paragraph block");
    }

    expect(paragraph.runs.at(0)).toMatchObject({
      kind: "text",
      text: "8 ",
      fontFamily: "Times New Roman",
      fontSize: 10,
      superscript: true,
    });
  });
});
