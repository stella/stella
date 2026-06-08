/**
 * Render a single paragraph as a block of markdown. Three cases: heading style
 * → `#`…`######`; list item → indented marker + inline content (Word's exact
 * marker preserved); plain prose → escaped inline content. Word's `Quote` /
 * `IntenseQuote` styles become blockquotes. Ported from eigenpal/docx-editor
 * PR #595.
 */

import type { DocxPackage, ListRendering, Paragraph } from "../types/document";
import { isHeadingStyle, parseHeadingLevel } from "./headings";
import { renderParagraphInline } from "./renderRuns";
import type { RenderContext } from "./types";

/**
 * Render a paragraph and return the block text. No surrounding blank line: the
 * caller joins blocks.
 */
export function renderParagraph(
  ctx: RenderContext,
  pkg: DocxPackage | undefined,
  para: Paragraph,
): string {
  const inline = renderParagraphInline(ctx, pkg, para.content, para.paraId);
  const styleId = para.formatting?.styleId;

  if (isHeadingStyle(styleId)) {
    if (!inline) {
      return ""; // Drop empty headings — `#` alone is just literal text.
    }
    const level = parseHeadingLevel(styleId) ?? 1;
    const hashes = "#".repeat(Math.max(1, Math.min(6, level)));
    return `${hashes} ${inline}`;
  }

  // A numbering level with `w:vanish` keeps `listRendering` but hides the
  // marker, so render it as plain prose rather than a Markdown list item.
  if (para.listRendering && !para.listRendering.markerHidden) {
    return renderListItem(para.listRendering, inline);
  }

  // Word's built-in quote styles: `Quote`, `IntenseQuote`. Avoid loose matches
  // like `/quote/i` that catch `BlockQuoteCustom` or even `NoQuote`.
  if (styleId === "Quote" || styleId === "IntenseQuote") {
    return inline
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  return escapeLeadingBlockMarker(inline);
}

/**
 * A plain paragraph whose visible text begins with markdown block syntax (e.g.
 * `# Not a heading`, `- value`, `1. value`, `> quote`) would be reclassified as
 * a heading/list/blockquote on re-parse, even though Word carries no matching
 * style/list metadata. Escape the leading marker so literal text round-trips.
 */
function escapeLeadingBlockMarker(text: string): string {
  return text
    .replace(/^(\s*)([#>])/u, "$1\\$2")
    .replace(/^(\s*)([-+*])(\s)/u, "$1\\$2$3")
    .replace(/^(\s*)(\d{1,9})([.)])(\s)/u, "$1$2\\$3$4");
}

function renderListItem(list: ListRendering, inline: string): string {
  const indent = "  ".repeat(list.level);
  if (list.isBullet) {
    return `${indent}- ${inline}`.trimEnd();
  }
  // Preserve Word's exact marker (e.g. "1.", "a)", "i."). Strip trailing
  // whitespace from the marker but keep its punctuation intact.
  const marker = list.marker.trim();
  return `${indent}${marker} ${inline}`.trimEnd();
}
