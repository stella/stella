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

type VerticalRelativeTo = NonNullable<
  ImageRunPosition["vertical"]
>["relativeTo"];
type VerticalAlign = NonNullable<ImageRunPosition["vertical"]>["align"];

/**
 * `true` when a vertical anchor pins the box to a fixed position on the page
 * (page body, text margin, or a margin strip) rather than to the surrounding
 * text flow. A `topAndBottom` box with such an anchor reserves a full-width
 * band; `paragraph`/`line` anchors keep folio's in-flow handling. Exhaustive
 * over the OOXML `ST_RelFromV` set so a new relativeFrom value forces a decision
 * here instead of silently falling through. eigenpal #694.
 */
export function isPageFrameRelativeAnchor(
  relativeTo: VerticalRelativeTo,
): boolean {
  switch (relativeTo) {
    case "page":
    case "margin":
    case "topMargin":
    case "bottomMargin":
    case "insideMargin":
    case "outsideMargin":
      return true;
    case "paragraph":
    case "line":
    case undefined:
      return false;
    default:
      relativeTo satisfies never;
      return false;
  }
}

/** Page geometry needed to resolve a band box's vertical anchor. */
export type BandVerticalGeometry = {
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  boxHeight: number;
};

/**
 * Page-absolute `[top, bottom]` (px) of the frame a vertical anchor positions
 * within. `insideMargin`/`outsideMargin` map to the top/bottom margin strips
 * (vertical page parity is not modelled); flow-relative anchors fall back to the
 * content box, which is also where a page-pinned band with no usable anchor
 * sits. eigenpal #694.
 */
function bandVerticalFrame(
  relativeTo: VerticalRelativeTo,
  geometry: BandVerticalGeometry,
): { top: number; bottom: number } {
  const { pageHeight, marginTop, marginBottom } = geometry;
  switch (relativeTo) {
    case "page":
      return { top: 0, bottom: pageHeight };
    case "topMargin":
    case "insideMargin":
      return { top: 0, bottom: marginTop };
    case "bottomMargin":
    case "outsideMargin":
      return { top: pageHeight - marginBottom, bottom: pageHeight };
    case "margin":
    case "paragraph":
    case "line":
    case undefined:
      return { top: marginTop, bottom: pageHeight - marginBottom };
    default:
      relativeTo satisfies never;
      return { top: marginTop, bottom: pageHeight - marginBottom };
  }
}

/** Page-absolute top Y (px) of the box within its frame for a bare `align`. */
function alignedFrameTop(
  align: VerticalAlign,
  frame: { top: number; bottom: number },
  boxHeight: number,
): number {
  switch (align) {
    case "center":
      return frame.top + (frame.bottom - frame.top - boxHeight) / 2;
    case "bottom":
    case "outside":
      return frame.bottom - boxHeight;
    case "top":
    case "inside":
    case undefined:
      return frame.top;
    default:
      align satisfies never;
      return frame.top;
  }
}

/**
 * Content-area top Y (px) of a `topAndBottom` band box's reserved band, resolved
 * from its OOXML vertical anchor. Shared by the measure pass
 * (`extractFloatingZones`) and the layout pass (`layoutTextBox`) so the reserved
 * band and the painted box land at the same Y. Within the anchor's frame an
 * explicit `posOffset` wins, then `align` (top/center/bottom/inside/outside);
 * otherwise the box sits at the frame top. The result is content-relative
 * (0 = content top), so a page/margin-strip frame is converted by subtracting
 * the top margin. Ported from eigenpal #694.
 */
export function bandTopContentY(
  vertical: ImageRunPosition["vertical"],
  geometry: BandVerticalGeometry,
): number {
  const frame = bandVerticalFrame(vertical?.relativeTo, geometry);
  const pageTop =
    vertical?.posOffset !== undefined
      ? frame.top + emuToPixels(vertical.posOffset)
      : alignedFrameTop(vertical?.align, frame, geometry.boxHeight);
  return pageTop - geometry.marginTop;
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
