/**
 * Render a single paragraph as a block of markdown. Three cases: heading style
 * → `#`…`######`; list item → indented marker + inline content (Word's exact
 * marker preserved); plain prose → escaped inline content. Word's `Quote` /
 * `IntenseQuote` styles become blockquotes. Ported from eigenpal/docx-editor
 * PR #595.
 */

import { resolveListTemplate } from "../layout-bridge/toFlowBlocks";
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
    return renderListItem(ctx, para.listRendering, inline);
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
  // Escape at the start of every line (`m` flag), not just the paragraph: an
  // inline break (soft break / page break) can put block syntax at the start of
  // a later line. Only horizontal whitespace `[ \t]` leads the marker so the
  // anchor doesn't cross the newline.
  return text
    .replace(/^([ \t]*)([#>])/gmu, "$1\\$2")
    .replace(/^([ \t]*)([-+*])([ \t])/gmu, "$1\\$2$3")
    .replace(/^([ \t]*)(\d{1,9})([.)])([ \t])/gmu, "$1$2\\$3$4");
}

function renderListItem(
  ctx: RenderContext,
  list: ListRendering,
  inline: string,
): string {
  const indent = "  ".repeat(list.level);
  if (list.isBullet) {
    return `${indent}- ${inline}`.trimEnd();
  }
  // Preserve Word's exact marker (e.g. "1.", "a)", "i."). Strip trailing
  // whitespace from the marker but keep its punctuation intact.
  const marker = list.marker.includes("%")
    ? resolveTemplateMarker(ctx, list)
    : list.marker.trim();
  return `${indent}${marker} ${inline}`.trimEnd();
}

/**
 * Resolve a `lvlText`-style marker template ("%1.") against live counters, the
 * same way the layout engine paints it. Editor-emitted documents carry
 * templates rather than baked numbers, so the serializer must count items in
 * document order; counters live on the context (`listCounters`) so they span
 * the whole render, including list items inside tables and block SDTs.
 */
function resolveTemplateMarker(
  ctx: RenderContext,
  list: ListRendering,
): string {
  const counters =
    ctx.listCounters.get(list.numId) ??
    (Array.from({ length: 9 }, () => 0) as number[]);
  const level = list.level;
  const seenKey = `${list.numId}:${level}`;
  if (!ctx.listSeenLevels.has(seenKey)) {
    ctx.listSeenLevels.add(seenKey);
    if (list.startOverride !== undefined) {
      counters[level] = list.startOverride - 1;
    }
  }
  counters[level] = (counters[level] ?? 0) + 1;
  for (let i = level + 1; i < counters.length; i += 1) {
    counters[i] = 0;
  }
  ctx.listCounters.set(list.numId, counters);
  const levelFormats =
    list.levelNumFmts ?? (list.numFmt ? [list.numFmt] : undefined);
  return resolveListTemplate(
    list.marker,
    counters,
    levelFormats,
    list.isLegal,
  ).trim();
}
