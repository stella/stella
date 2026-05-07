import { describe, expect, test } from "bun:test";

import type { Footnote } from "../types/document";
import { convertFootnoteToContent } from "./footnoteLayout";

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
});
