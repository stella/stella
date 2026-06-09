import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  PageMargins,
  ParagraphBlock,
  ParagraphFragment,
  Page,
  TableBlock,
  TableFragment,
  TextBoxBlock,
} from "../layout-engine/types";
import { buildBookmarkPageMap } from "./bookmarkPages";

const MARGINS: PageMargins = { top: 96, right: 96, bottom: 96, left: 96 };

const para = (id: string, bookmarks?: string[]): ParagraphBlock => ({
  kind: "paragraph",
  id,
  runs: [],
  ...(bookmarks ? { bookmarks } : {}),
});

const fragment = (blockId: string): ParagraphFragment => ({
  kind: "paragraph",
  blockId,
  x: 0,
  y: 0,
  width: 600,
  height: 20,
  fromLine: 0,
  toLine: 1,
});

const tableFragment = (
  blockId: string,
  fromRow: number,
  toRow: number,
): TableFragment => ({
  kind: "table",
  blockId,
  x: 0,
  y: 0,
  width: 600,
  height: 20,
  fromRow,
  toRow,
});

const page = (number: number, blockIds: string[]): Page => ({
  number,
  fragments: blockIds.map(fragment),
  margins: MARGINS,
  size: { w: 816, h: 1056 },
});

describe("buildBookmarkPageMap", () => {
  test("maps each bookmark to the page its paragraph lands on", () => {
    const blocks: FlowBlock[] = [
      para("a", ["intro"]),
      para("b"),
      para("c", ["schedule", "exhibit"]),
    ];
    const pages = [page(1, ["a", "b"]), page(2, ["c"])];

    const map = buildBookmarkPageMap(pages, blocks);

    expect(map.get("intro")).toBe(1);
    expect(map.get("schedule")).toBe(2);
    expect(map.get("exhibit")).toBe(2);
    expect(map.size).toBe(3);
  });

  test("a bookmark whose paragraph splits across pages takes the first page", () => {
    const blocks: FlowBlock[] = [para("a", ["long"])];
    const pages = [page(2, ["a"]), page(3, ["a"])];

    expect(buildBookmarkPageMap(pages, blocks).get("long")).toBe(2);
  });

  test("maps bookmarks inside tables and text boxes to their container page", () => {
    const table: TableBlock = {
      kind: "table",
      id: "table",
      rows: [
        {
          id: "row",
          cells: [{ id: "cell", blocks: [para("nested", ["in-table"])] }],
        },
      ],
    };
    const textBox: TextBoxBlock = {
      kind: "textBox",
      id: "box",
      width: 200,
      content: [para("inside-box", ["in-box"])],
    };
    const blocks: FlowBlock[] = [table, textBox];
    const pages: Page[] = [
      {
        number: 4,
        fragments: [tableFragment("table", 0, 1)],
        margins: MARGINS,
        size: { w: 816, h: 1056 },
      },
      page(5, ["box"]),
    ];

    const map = buildBookmarkPageMap(pages, blocks);

    expect(map.get("in-table")).toBe(4);
    expect(map.get("in-box")).toBe(5);
  });

  test("maps bookmarks inside split tables to the row's fragment page", () => {
    const table: TableBlock = {
      kind: "table",
      id: "table",
      rows: [
        {
          id: "r0",
          cells: [{ id: "c0", blocks: [para("row0", ["first-row"])] }],
        },
        {
          id: "r1",
          cells: [{ id: "c1", blocks: [para("row1", ["second-row"])] }],
        },
      ],
    };
    const pages: Page[] = [
      {
        number: 8,
        fragments: [tableFragment("table", 0, 1)],
        margins: MARGINS,
        size: { w: 816, h: 1056 },
      },
      {
        number: 9,
        fragments: [tableFragment("table", 1, 2)],
        margins: MARGINS,
        size: { w: 816, h: 1056 },
      },
    ];

    const map = buildBookmarkPageMap(pages, [table]);

    expect(map.get("first-row")).toBe(8);
    expect(map.get("second-row")).toBe(9);
  });

  test("returns an empty map when no block carries a bookmark", () => {
    const blocks: FlowBlock[] = [para("a"), para("b")];
    const pages = [page(1, ["a", "b"])];

    expect(buildBookmarkPageMap(pages, blocks).size).toBe(0);
  });
});
