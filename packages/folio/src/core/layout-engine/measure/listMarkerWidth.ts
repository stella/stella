/**
 * List marker inline-width resolution.
 *
 * The painter renders the list marker as an inline-block at the start of the
 * first body line. To match Word's rendering (ECMA-376 §17.9.25 — default
 * `w:suff="tab"` after the marker), the inline-block is sized so the body
 * text aligns at the next tab stop. Long markers like "1.1.1." take their
 * natural width and the body follows them.
 *
 * Both the painter (`renderParagraph.ts`) and the measurer (`measureParagraph`)
 * call into this so they agree on the marker's footprint — otherwise long
 * markers overflow the right edge of the first line. The painter applies the
 * returned width as `min-width`; the measurer subtracts the same value from
 * the first line's available width.
 */
import type { ParagraphBlock, TextRun } from "../types";
import { measureTextWidth, ptToPx } from "./measureContainer";
import type { FontStyle } from "./measureContainer";

const DEFAULT_FONT_FAMILY = "Calibri";
const DEFAULT_FONT_SIZE = 11;

/**
 * OOXML default `w:defaultTabStop` (§17.6.13) when settings.xml omits it.
 * 720 twips = 0.5 inch = 48 CSS px at 96 DPI. Folio doesn't currently parse
 * settings.xml; documents that override this fall back to the OOXML default.
 */
export const DEFAULT_TAB_STOP_TWIPS = 720;

const TWIPS_TO_PX = 96 / 1440;

/**
 * Marker font resolution per ECMA-376 §17.9.6:
 *  1. explicit numbering-level rPr (`attrs.listMarkerFont*`),
 *  2. first body text run's font,
 *  3. paragraph defaults, then document defaults.
 */
export function resolveListMarkerFont(block: ParagraphBlock): {
  fontFamily: string;
  fontSize: number;
} {
  const attrs = block.attrs;
  const firstTextRun = block.runs.find((r): r is TextRun => r.kind === "text");
  const fontFamily =
    attrs?.listMarkerFontFamily ??
    firstTextRun?.fontFamily ??
    attrs?.defaultFontFamily ??
    DEFAULT_FONT_FAMILY;
  const fontSize =
    attrs?.listMarkerFontSize ??
    firstTextRun?.fontSize ??
    attrs?.defaultFontSize ??
    DEFAULT_FONT_SIZE;
  return { fontFamily, fontSize };
}

/**
 * Compute the marker's inline-block width in pixels, or 0 if the paragraph
 * has no rendered marker.
 *
 * Honors:
 *  - hanging indent — body wraps at `indentLeft`, marker sits at
 *    `indentLeft - hanging`. Width is `hanging` so the marker fills the slot.
 *  - `w:suff` (§17.9.25): `nothing` → natural width, `space` → natural +
 *    one space glyph, `tab` (default) → grow to the next tab stop.
 *  - `w:tabs` on the paragraph: non-`clear`/non-`bar` stops past the marker.
 *    `bar` (§17.3.1.37) is a vertical line and doesn't advance the cursor.
 *  - default tab grid: stops at multiples of `DEFAULT_TAB_STOP_TWIPS`,
 *    anchored at 0 (start of body content area, NOT `w:ind`).
 *
 * Word interleaves the two — both custom tabs and default-grid stops are
 * candidates; the closest stop past the marker wins (§17.6.13: the default
 * grid is not erased by custom tabs, just augmented).
 */
export function getListMarkerInlineWidth(block: ParagraphBlock): number {
  const attrs = block.attrs;
  if (!attrs?.listMarker || attrs.listMarkerHidden) {
    return 0;
  }

  const { fontFamily, fontSize } = resolveListMarkerFont(block);
  const style: FontStyle = { fontFamily, fontSize };
  const naturalWidth = measureTextWidth(attrs.listMarker, style);

  // §17.9.25 — `w:suff` controls what follows the marker before body text.
  const suffix = attrs.listMarkerSuffix ?? "tab";
  if (suffix === "nothing") {
    return naturalWidth;
  }
  if (suffix === "space") {
    return naturalWidth + measureTextWidth(" ", style);
  }

  // Default suffix is `tab`. Body text aligns at the next stop past
  // `markerStart + naturalWidth`. `>=` (not `>`) is intentional: a tab
  // landing exactly at the marker's right edge IS valid — Word renders
  // the body at that column with zero residual gap. §17.9.27.
  const indent = attrs.indent;
  const indentLeft = indent?.left ?? 0;
  const firstLine = indent?.firstLine ?? 0;
  const hanging = indent?.hanging ?? 0;
  const markerStartPx =
    hanging > 0 ? indentLeft - hanging : indentLeft + firstLine;
  const minBodyStart = markerStartPx + naturalWidth;

  // Build tab-stop candidates. For hanging lists, the right edge of the
  // hanging slot (= indentLeft) is the implicit first tab stop after the
  // marker — body wraps there. Add it explicitly so a fitting marker
  // snaps to indentLeft rather than to a default-grid stop that happens
  // to land inside the hanging slot.
  const customTabs = (attrs.tabs ?? [])
    .filter((t) => t.val !== "clear" && t.val !== "bar")
    .map((t) => t.pos * TWIPS_TO_PX);
  if (hanging > 0) {
    customTabs.push(indentLeft);
  }

  // For hanging lists, body must never land inside the hanging slot; clamp
  // the search past indentLeft so the default grid can't fire there.
  const searchStart =
    hanging > 0 ? Math.max(minBodyStart, indentLeft) : minBodyStart;

  const firstCustomPast = customTabs
    .filter((px) => px >= searchStart)
    .sort((a, b) => a - b)[0];

  // Honor the document's `w:defaultTabStop` (§17.6.13) when stamped onto
  // the block by `toFlowBlocks`; fall back to the OOXML default otherwise.
  const defaultTabStopTwips =
    attrs.defaultTabStopTwips ?? DEFAULT_TAB_STOP_TWIPS;
  const defaultTabStopPx = defaultTabStopTwips * TWIPS_TO_PX;
  // `Math.ceil` preserves equality (§17.9.27): a tab landing exactly on
  // `searchStart` IS valid; only advance to the next interval when
  // `searchStart` is strictly between two stops.
  const firstGridPast =
    defaultTabStopPx > 0
      ? Math.ceil(searchStart / defaultTabStopPx) * defaultTabStopPx
      : undefined;

  // Closest wins — Word doesn't let a far custom tab override a closer
  // default-grid stop (default grid resumes between custom tabs).
  let bodyStart: number | undefined;
  if (firstCustomPast !== undefined && firstGridPast !== undefined) {
    bodyStart = Math.min(firstCustomPast, firstGridPast);
  } else {
    bodyStart = firstCustomPast ?? firstGridPast;
  }

  if (bodyStart === undefined) {
    // No tab grid available: fall back to a half-em visual gap so the
    // marker doesn't butt up against the body text.
    return naturalWidth + ptToPx(fontSize) * 0.5;
  }
  return bodyStart - markerStartPx;
}
