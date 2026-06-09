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
  const bookmarksByBlockId = new Map<BlockId, readonly string[]>();
  for (const block of blocks) {
    if (
      block.kind === "paragraph" &&
      block.bookmarks &&
      block.bookmarks.length > 0
    ) {
      bookmarksByBlockId.set(block.id, block.bookmarks);
    }
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
