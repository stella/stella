import type { BlockId, FlowBlock, Page } from "../layout-engine/types";

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
  const bookmarksByBlockId = new Map<BlockId, string[]>();
  for (const block of blocks) {
    collectBookmarksByTopLevelBlock(block, block.id, bookmarksByBlockId);
  }

  const pageByBookmark = new Map<string, number>();
  if (bookmarksByBlockId.size === 0) {
    return pageByBookmark;
  }

  for (const page of pages) {
    for (const fragment of page.fragments) {
      const names = bookmarksByBlockId.get(fragment.blockId);
      if (!names) {
        continue;
      }
      for (const name of names) {
        if (!pageByBookmark.has(name)) {
          pageByBookmark.set(name, page.number);
        }
      }
    }
  }

  return pageByBookmark;
}

function collectBookmarksByTopLevelBlock(
  block: FlowBlock,
  topLevelId: BlockId,
  bookmarksByBlockId: Map<BlockId, string[]>,
): void {
  if (block.kind === "paragraph") {
    if (!block.bookmarks || block.bookmarks.length === 0) {
      return;
    }
    let names = bookmarksByBlockId.get(topLevelId);
    if (!names) {
      names = [];
      bookmarksByBlockId.set(topLevelId, names);
    }
    names.push(...block.bookmarks);
    return;
  }

  if (block.kind === "table") {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) {
          collectBookmarksByTopLevelBlock(
            child,
            topLevelId,
            bookmarksByBlockId,
          );
        }
      }
    }
    return;
  }

  if (block.kind === "textBox") {
    for (const child of block.content) {
      collectBookmarksByTopLevelBlock(child, topLevelId, bookmarksByBlockId);
    }
  }
}
