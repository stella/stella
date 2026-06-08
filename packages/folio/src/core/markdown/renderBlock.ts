/**
 * Block-level dispatcher. Walks `BlockContent[]` and joins the rendered
 * markdown for each block, suppressing redundant blank lines between list items
 * of the same list. Ported from eigenpal/docx-editor PR #595.
 */

import type { BlockContent, DocxPackage } from "../types/document";
import { renderParagraph } from "./renderParagraph";
import { renderTable } from "./renderTable";
import type { RenderContext } from "./types";

/**
 * In `trackedChanges: "clean"` mode every change is accepted. A paragraph whose
 * end-of-paragraph mark is a pending deletion (`pPrMark.kind === "del"`) loses
 * its break on accept and merges with the following paragraph. Word's join
 * keeps the FIRST paragraph's properties (style, list) and drops the resolved
 * mark; the surviving break is the next paragraph's, so a run of consecutive
 * deletions collapses into one paragraph. A non-paragraph next block (table,
 * SDT) is structurally incompatible and stays unmerged, matching the editor's
 * accept-change join guard (`commands/comments.ts`).
 */
function mergeAcceptedParagraphBreaks(blocks: BlockContent[]): BlockContent[] {
  const merged: BlockContent[] = [];
  for (const block of blocks) {
    const prev = merged.at(-1);
    if (
      prev?.type === "paragraph" &&
      prev.pPrMark?.kind === "del" &&
      block.type === "paragraph"
    ) {
      // Drop the resolved deletion mark; inherit the next paragraph's mark so a
      // chain keeps merging.
      const { pPrMark: _resolved, ...base } = prev;
      const next = block.pPrMark;
      const content = [...prev.content, ...block.content];
      merged[merged.length - 1] = next
        ? { ...base, content, pPrMark: next }
        : { ...base, content };
      continue;
    }
    merged.push(block);
  }
  return merged;
}

export function renderBlocks(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  blocks: BlockContent[],
): string {
  const out: string[] = [];
  let prevWasListItem = false;

  const ordered =
    ctx.opts.trackedChanges === "clean"
      ? mergeAcceptedParagraphBreaks(blocks)
      : blocks;

  for (const block of ordered) {
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
