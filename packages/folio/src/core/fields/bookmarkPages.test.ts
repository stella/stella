import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  PageMargins,
  ParagraphBlock,
  ParagraphFragment,
  Page,
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

  test("returns an empty map when no block carries a bookmark", () => {
    const blocks: FlowBlock[] = [para("a"), para("b")];
    const pages = [page(1, ["a", "b"])];

    expect(buildBookmarkPageMap(pages, blocks).size).toBe(0);
  });
});
