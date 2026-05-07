import { describe, expect, test } from "bun:test";

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

  test("measures table footnotes without a caller-provided measurement hook", () => {
    const content = convertFootnoteToContent(emptyFootnoteWithTable, 3, 400);

    expect(content.blocks.map((block) => block.kind)).toEqual(["table"]);
    expect(Number.isNaN(content.height)).toBe(false);
    expect(content.height).toBeGreaterThan(0);

    const tableMeasure = content.measures.at(0);
    expect(tableMeasure?.kind).toBe("table");
    if (tableMeasure?.kind !== "table") {
      throw new Error("Expected footnote table to have a table measure");
    }
    expect(tableMeasure.totalHeight).toBeGreaterThan(0);
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

    const table = applyFootnotePresentation(blocks, 4).at(0);
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
});
