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

type HorizontalRelativeTo = NonNullable<
  ImageRunPosition["horizontal"]
>["relativeTo"];
type HorizontalAlign = NonNullable<ImageRunPosition["horizontal"]>["align"];

/**
 * Page-absolute `[left, right]` (px) of the frame a horizontal anchor positions
 * within. `inside`/`outsideMargin` map to the left/right margin strips (page
 * parity is not modelled); `column`/`character` fall back to the content box
 * (folio has no per-column/character X here). eigenpal #694.
 */
function bandHorizontalFrame(
  relativeTo: HorizontalRelativeTo,
  geometry: BandHorizontalGeometry,
): { left: number; right: number } {
  const { pageWidth, marginLeft, marginRight } = geometry;
  switch (relativeTo) {
    case "page":
      return { left: 0, right: pageWidth };
    case "leftMargin":
    case "insideMargin":
      return { left: 0, right: marginLeft };
    case "rightMargin":
    case "outsideMargin":
      return { left: pageWidth - marginRight, right: pageWidth };
    case "margin":
    case "column":
    case "character":
    case undefined:
      return { left: marginLeft, right: pageWidth - marginRight };
    default:
      relativeTo satisfies never;
      return { left: marginLeft, right: pageWidth - marginRight };
  }
}

/** Page-absolute left X (px) of the box within its frame for a bare `align`. */
function alignedFrameLeft(
  align: HorizontalAlign,
  frame: { left: number; right: number },
  boxWidth: number,
): number {
  switch (align) {
    case "center":
      return frame.left + (frame.right - frame.left - boxWidth) / 2;
    case "right":
    case "outside":
      return frame.right - boxWidth;
    case "left":
    case "inside":
    case undefined:
      return frame.left;
    default:
      align satisfies never;
      return frame.left;
  }
}

/**
 * Page-absolute left X (px) of a `topAndBottom` band box, resolved from its
 * OOXML horizontal anchor. Picks the anchor's frame (page, content box, or a
 * left/right margin strip), then within it an explicit `posOffset` wins, else
 * `align` (left/center/right/inside/outside); otherwise the box sits at the
 * frame's left edge. The band itself is always full-width, so this only shifts
 * where the box paints, not the reserved vertical space. Ported from eigenpal
 * #694.
 */
export function bandFragmentX(
  horizontal: ImageRunPosition["horizontal"],
  geometry: BandHorizontalGeometry,
): number {
  const frame = bandHorizontalFrame(horizontal?.relativeTo, geometry);
  if (horizontal?.posOffset !== undefined) {
    return frame.left + emuToPixels(horizontal.posOffset);
  }
  return alignedFrameLeft(horizontal?.align, frame, geometry.boxWidth);
}
