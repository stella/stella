/**
 * Block-level dispatcher. Walks `BlockContent[]` and joins the rendered
 * markdown for each block, suppressing redundant blank lines between list items
 * of the same list. Ported from eigenpal/docx-editor PR #595.
 */

import type { BlockContent, DocxPackage } from "../types/document";
import { renderParagraph } from "./renderParagraph";
import { renderTable } from "./renderTable";
import type { RenderContext } from "./types";

export function renderBlocks(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  blocks: BlockContent[],
): string {
  const out: string[] = [];
  let prevWasListItem = false;

  for (const block of blocks) {
    if (block.type === "paragraph") {
      // A hidden-marker (`w:vanish`) list paragraph renders as plain prose, so
      // treat it as prose here too (it must not suppress the blank line after a
      // real list item).
      const isListItem =
        !!block.listRendering && !block.listRendering.markerHidden;
      const md = renderParagraph(ctx, pkg, block);
      if (!md) {
        prevWasListItem = false;
        continue;
      }
      if (isListItem && prevWasListItem) {
        out.push(md);
      } else if (out.length) {
        out.push("", md);
      } else {
        out.push(md);
      }
      prevWasListItem = isListItem;
    } else if (block.type === "table") {
      const md = renderTable(ctx, pkg, block);
      if (md) {
        if (out.length) {
          out.push("");
        }
        out.push(md);
      }
      prevWasListItem = false;
    } else {
      // blockSdt — `BlockSdt.content` is a subset of BlockContent.
      const nested = renderBlocks(ctx, pkg, block.content);
      if (nested) {
        if (out.length) {
          out.push("");
        }
        out.push(nested);
      }
    }
  }

  return out.join("\n");
}
