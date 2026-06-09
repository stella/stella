import type { FlowBlock, ParagraphBlock } from "../layout-engine/types";

/**
 * Map each bookmark name to the text of its anchoring paragraph, for REF
 * cross-references (e.g. "see Section 1.3"). Folio anchors bookmarks at the
 * paragraph level, so a REF resolves to that paragraph's visible text. Document
 * order, independent of layout. First paragraph carrying a name wins.
 */
export function buildBookmarkText(
  blocks: readonly FlowBlock[],
): Map<string, string> {
  const map = new Map<string, string>();
  walkBlocks(blocks, map);
  return map;
}

function walkBlocks(
  blocks: readonly FlowBlock[],
  map: Map<string, string>,
): void {
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      if (!block.bookmarks || block.bookmarks.length === 0) {
        continue;
      }
      const text = paragraphText(block);
      for (const name of block.bookmarks) {
        if (!map.has(name)) {
          map.set(name, text);
        }
      }
    } else if (block.kind === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          walkBlocks(cell.blocks, map);
        }
      }
    }
  }
}

function paragraphText(block: ParagraphBlock): string {
  let text = "";
  for (const run of block.runs) {
    if (run.kind === "text") {
      text += run.text;
    }
  }
  return text.trim();
}
