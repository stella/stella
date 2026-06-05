/**
 * Floating text-box predicates. Ported from eigenpal docx-editor #474.
 */

import { isFloatingWrapType, isWrapNone } from "../docx/wrapTypes";
import { emuToPixels } from "../utils/units";
import type { ImageRunPosition, TextBoxBlock } from "./types";

export type TextBoxFlowAttrs = Pick<TextBoxBlock, "displayMode" | "wrapType">;

/**
 * `true` when the text box is anchored outside normal block flow — either
 * via the `float` display mode or via an OOXML floating wrap type (which
 * includes `topAndBottom`; see {@link floatingTextBoxReservesBand}).
 */
export function isFloatingTextBoxBlock(block: TextBoxFlowAttrs): boolean {
  return block.displayMode === "float" || isFloatingWrapType(block.wrapType);
}

/**
 * `true` when a floating text box should also reduce surrounding text
 * line widths. Excludes wrapNone (`behind`/`inFront`) and `topAndBottom`
 * which are positioned floats but do not carve a horizontal exclusion.
 */
export function floatingTextBoxWrapsText(block: TextBoxFlowAttrs): boolean {
  return (
    isFloatingTextBoxBlock(block) &&
    !isWrapNone(block.wrapType) &&
    block.wrapType !== "topAndBottom"
  );
}

/**
 * `true` when a floating text box reserves a full-width vertical band rather
 * than a side exclusion. `topAndBottom` boxes break the text above and below
 * the box (no text beside it), so surrounding lines flow past the band.
 * Ported from eigenpal #694.
 */
export function floatingTextBoxReservesBand(block: TextBoxFlowAttrs): boolean {
  return isFloatingTextBoxBlock(block) && block.wrapType === "topAndBottom";
}

/**
 * Content-area top Y (px) of a `topAndBottom` band box's reserved band, resolved
 * from its OOXML vertical anchor. Shared by the measure pass
 * (`extractFloatingZones`) and the layout pass (`layoutTextBox`) so the reserved
 * band and the painted box land at the same Y — a page-relative offset is
 * measured from the page edge (subtract the top margin); a margin-relative
 * offset (or no offset) is already content-relative. Ported from eigenpal #694.
 */
export function bandTopContentY(
  vertical: ImageRunPosition["vertical"],
  marginTop: number,
): number {
  const offset =
    vertical?.posOffset !== undefined ? emuToPixels(vertical.posOffset) : 0;
  return vertical?.relativeTo === "page" ? offset - marginTop : offset;
}

/** Page geometry needed to resolve a band box's horizontal anchor. */
export type BandHorizontalGeometry = {
  pageWidth: number;
  marginLeft: number;
  marginRight: number;
  boxWidth: number;
};

/**
 * Page-absolute left X (px) of a `topAndBottom` band box, resolved from its
 * OOXML horizontal anchor. A page-relative anchor measures from the page edge;
 * a margin/column anchor measures from the content box. Within that frame an
 * explicit `posOffset` wins, then `align` (center/right); otherwise the box sits
 * at the frame's left edge. The band itself is always full-width, so this only
 * shifts where the box paints, not the reserved vertical space. Ported from
 * eigenpal #694.
 */
export function bandFragmentX(
  horizontal: ImageRunPosition["horizontal"],
  geometry: BandHorizontalGeometry,
): number {
  const { pageWidth, marginLeft, marginRight, boxWidth } = geometry;
  const usesPageFrame = horizontal?.relativeTo === "page";
  const frameLeft = usesPageFrame ? 0 : marginLeft;
  const frameRight = usesPageFrame ? pageWidth : pageWidth - marginRight;

  if (horizontal?.posOffset !== undefined) {
    return frameLeft + emuToPixels(horizontal.posOffset);
  }
  if (horizontal?.align === "center") {
    return frameLeft + (frameRight - frameLeft - boxWidth) / 2;
  }
  if (horizontal?.align === "right" || horizontal?.align === "outside") {
    return frameRight - boxWidth;
  }
  return frameLeft;
}
