import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  ParagraphBlock,
  TableBlock,
  TextBoxBlock,
} from "../layout-engine/types";
import { collectFootnoteRefs } from "./footnoteLayout";

function paragraphWithFootnoteRef(
  id: string,
  footnoteId: number,
  pmStart: number,
): ParagraphBlock {
  return {
    kind: "paragraph",
    id,
    runs: [
      {
        kind: "text",
        text: "x",
        footnoteRefId: footnoteId,
        pmStart,
        pmEnd: pmStart + 1,
      },
    ],
  };
}

function emptyParagraph(id: string): ParagraphBlock {
  return { kind: "paragraph", id, runs: [] };
}

describe("collectFootnoteRefs", () => {
  test("collects references from top-level paragraphs in document order", () => {
    const blocks: FlowBlock[] = [
      paragraphWithFootnoteRef("p1", 1, 10),
      emptyParagraph("p2"),
      paragraphWithFootnoteRef("p3", 2, 30),
    ];

    expect(collectFootnoteRefs(blocks)).toEqual([
      { footnoteId: 1, pmPos: 10 },
      { footnoteId: 2, pmPos: 30 },
    ]);
  });

  test("recurses into table cells (regression: refs in tables were dropped)", () => {
    const table: TableBlock = {
      kind: "table",
      id: "t1",
      rows: [
        {
          id: "r1",
          cells: [
            {
              id: "c1",
              blocks: [paragraphWithFootnoteRef("p-cell-1", 5, 100)],
            },
            {
              id: "c2",
              blocks: [paragraphWithFootnoteRef("p-cell-2", 6, 120)],
            },
          ],
        },
      ],
    };
    const blocks: FlowBlock[] = [
      paragraphWithFootnoteRef("p-before", 1, 10),
      table,
      paragraphWithFootnoteRef("p-after", 9, 200),
    ];

    expect(collectFootnoteRefs(blocks)).toEqual([
      { footnoteId: 1, pmPos: 10 },
      { footnoteId: 5, pmPos: 100 },
      { footnoteId: 6, pmPos: 120 },
      { footnoteId: 9, pmPos: 200 },
    ]);
  });

  test("recurses into tables nested inside table cells", () => {
    const innerTable: TableBlock = {
      kind: "table",
      id: "inner",
      rows: [
        {
          id: "ir1",
          cells: [
            {
              id: "ic1",
              blocks: [paragraphWithFootnoteRef("nested-p", 7, 150)],
            },
          ],
        },
      ],
    };
    const outerTable: TableBlock = {
      kind: "table",
      id: "outer",
      rows: [
        {
          id: "or1",
          cells: [{ id: "oc1", blocks: [innerTable] }],
        },
      ],
    };

    expect(collectFootnoteRefs([outerTable])).toEqual([
      { footnoteId: 7, pmPos: 150 },
    ]);
  });

  test("recurses into text box content", () => {
    const textBox: TextBoxBlock = {
      kind: "textBox",
      id: "tb1",
      width: 200,
      content: [paragraphWithFootnoteRef("tb-p", 4, 50)],
    };

    expect(collectFootnoteRefs([textBox])).toEqual([
      { footnoteId: 4, pmPos: 50 },
    ]);
  });

  test("falls back to pmPos 0 when run lacks pmStart", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p",
      runs: [{ kind: "text", text: "x", footnoteRefId: 3 }],
    };

    expect(collectFootnoteRefs([block])).toEqual([{ footnoteId: 3, pmPos: 0 }]);
  });
});
