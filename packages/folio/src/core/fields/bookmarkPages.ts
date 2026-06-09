import type { BlockId, FlowBlock, Page } from "../layout-engine/types";

type BookmarkAnchor =
  | { type: "block"; blockId: BlockId; names: string[] }
  | { type: "tableRow"; blockId: BlockId; rowIndex: number; names: string[] };

/**
 * Map each bookmark name to the 1-indexed page its anchoring paragraph lands on,
 * for PAGEREF resolution. Computed as a post-pass over a finished layout: walk
 * pages -> fragments -> the source block's bookmarks. A bookmark whose paragraph
 * splits across pages takes the first (lowest) page it appears on, matching how
 * Word resolves a PAGEREF to the start of the bookmark.
 */
export function buildBookmarkPageMap(
  pages: readonly Page[],
  blocks: readonly FlowBlock[],
): Map<string, number> {
  const anchors: BookmarkAnchor[] = [];
  for (const block of blocks) {
    collectBookmarkAnchors(block, block.id, anchors);
  }

  const pageByBookmark = new Map<string, number>();
  if (anchors.length === 0) {
    return pageByBookmark;
  }

  for (const page of pages) {
    for (const fragment of page.fragments) {
      for (const anchor of anchors) {
        if (!fragmentContainsAnchor(fragment, anchor)) {
          continue;
        }
        assignBookmarkPage(pageByBookmark, anchor.names, page.number);
      }
    }
  }

  return pageByBookmark;
}

function collectBookmarkAnchors(
  block: FlowBlock,
  topLevelId: BlockId,
  anchors: BookmarkAnchor[],
): void {
  if (block.kind === "paragraph") {
    if (!block.bookmarks || block.bookmarks.length === 0) {
      return;
    }
    anchors.push({
      type: "block",
      blockId: topLevelId,
      names: [...block.bookmarks],
    });
    return;
  }

  if (block.kind === "table") {
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex++) {
      const row = block.rows[rowIndex];
      if (!row) {
        continue;
      }
      for (const cell of row.cells) {
        for (const child of cell.blocks) {
          collectTableRowBookmarkAnchors(child, block.id, rowIndex, anchors);
        }
      }
    }
    return;
  }

  if (block.kind === "textBox") {
    for (const child of block.content) {
      collectBookmarkAnchors(child, topLevelId, anchors);
    }
  }
}

function collectTableRowBookmarkAnchors(
  block: FlowBlock,
  tableId: BlockId,
  rowIndex: number,
  anchors: BookmarkAnchor[],
): void {
  if (block.kind === "paragraph") {
    if (!block.bookmarks || block.bookmarks.length === 0) {
      return;
    }
    anchors.push({
      type: "tableRow",
      blockId: tableId,
      rowIndex,
      names: [...block.bookmarks],
    });
    return;
  }

  if (block.kind === "table") {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) {
          collectTableRowBookmarkAnchors(child, tableId, rowIndex, anchors);
        }
      }
    }
    return;
  }

  if (block.kind === "textBox") {
    for (const child of block.content) {
      collectTableRowBookmarkAnchors(child, tableId, rowIndex, anchors);
    }
  }
}

function fragmentContainsAnchor(
  fragment: Page["fragments"][number],
  anchor: BookmarkAnchor,
): boolean {
  if (fragment.blockId !== anchor.blockId) {
    return false;
  }
  if (anchor.type === "block") {
    return true;
  }
  return (
    fragment.kind === "table" &&
    anchor.rowIndex >= fragment.fromRow &&
    anchor.rowIndex < fragment.toRow
  );
}

function assignBookmarkPage(
  pageByBookmark: Map<string, number>,
  names: readonly string[],
  pageNumber: number,
): void {
  for (const name of names) {
    if (!pageByBookmark.has(name)) {
      pageByBookmark.set(name, pageNumber);
    }
  }
}
