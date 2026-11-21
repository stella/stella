import { DOCUMENT_PANEL_BOTTOM_INSET } from "@stll/ui/panel-inset";

/** Gap between the selected line and its actions. */
export const SELECTION_TOOLBAR_OFFSET_PX = 8;
/** The least the bar keeps between itself and a clipping edge. */
export const SELECTION_TOOLBAR_EDGE_MARGIN_PX = 8;

type ToolbarRect = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

/** The block extent of the visible selected lines, clipped to the bounds. */
export type SelectionToolbarExtent = { top: number; bottom: number };

export type SelectionToolbarAnchor = {
  rect: DOMRect;
  bounds: DOMRect;
  /**
   * The visible selection's top and bottom. A bar placed by its anchor alone
   * (the selection's end, or the pointer) flips above that point when there
   * is no room below, which puts it over the selection's own earlier lines;
   * with the extent it clears every selected line it can.
   */
  extent?: SelectionToolbarExtent | undefined;
};

const clips = (overflow: string): boolean => overflow !== "visible";

/**
 * Whether a scroll can have moved the selected words under the bar. A host
 * listens for scroll across the whole document to keep the bar on its words,
 * and re-reading the selection closes an open menu. A scroll inside the
 * bar's own surfaces (a copy menu's preview) moves none of the words, so it
 * must not close the menu being read.
 */
export const scrollMovesSelection = (
  event: Event,
  surfaces: readonly (Node | null)[],
): boolean => {
  const { target } = event;
  return !(
    target instanceof Node &&
    surfaces.some((surface) => surface?.contains(target) === true)
  );
};

/** The reader's visible scroll area, in the selection document's coordinates. */
export const selectionToolbarBounds = (root: HTMLElement): DOMRect | null => {
  const view = root.ownerDocument.defaultView;
  if (view === null) {
    return null;
  }
  const viewport = view.visualViewport;
  let left = viewport?.offsetLeft ?? 0;
  let top = viewport?.offsetTop ?? 0;
  let right = left + (viewport?.width ?? view.innerWidth);
  let bottom = top + (viewport?.height ?? view.innerHeight);
  let clippedVertically = false;
  for (
    let element: HTMLElement | null = root;
    element !== null;
    element = element.parentElement
  ) {
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (clips(style.overflowX)) {
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
    }
    if (clips(style.overflowY)) {
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
      clippedVertically = true;
    }
    // Docked chrome (the floating composer) publishes the strip it covers on
    // its host; read it inline, because descendants inherit the property.
    const inset = Number.parseFloat(
      element.style.getPropertyValue(DOCUMENT_PANEL_BOTTOM_INSET),
    );
    if (inset > 0) {
      bottom = Math.min(bottom, rect.bottom - inset);
    }
  }
  // A reader without its own scroller still starts below the page chrome.
  if (!clippedVertically) {
    top = Math.max(top, root.getBoundingClientRect().top);
  }
  return right > left && bottom > top
    ? new DOMRect(left, top, right - left, bottom - top)
    : null;
};

const visible = (rect: ToolbarRect, bounds: ToolbarRect): boolean =>
  rect.right >= bounds.left &&
  rect.left <= bounds.right &&
  rect.bottom > bounds.top &&
  rect.top < bounds.bottom;

type SelectionToolbarAnchorOptions = {
  range: Range;
  root: HTMLElement;
  pointer?: { x: number; y: number };
};

/** Whole-selection boxes include off-screen text; use the end or last visible line. */
export const selectionToolbarAnchor = ({
  range,
  root,
  pointer,
}: SelectionToolbarAnchorOptions): SelectionToolbarAnchor | null => {
  const bounds = selectionToolbarBounds(root);
  if (bounds === null) {
    return null;
  }
  let lastVisible: DOMRect | null = null;
  let extentTop = Number.POSITIVE_INFINITY;
  let extentBottom = Number.NEGATIVE_INFINITY;
  const lines: DOMRect[] = [];
  for (const rect of range.getClientRects()) {
    if (rect.height > 0 && visible(rect, bounds)) {
      lastVisible = rect;
      lines.push(rect);
      extentTop = Math.min(extentTop, rect.top);
      extentBottom = Math.max(extentBottom, rect.bottom);
    }
  }
  if (lastVisible === null) {
    return null;
  }
  const extent: SelectionToolbarExtent = {
    top: Math.max(bounds.top, extentTop),
    bottom: Math.min(bounds.bottom, extentBottom),
  };
  if (
    pointer !== undefined &&
    pointer.x >= bounds.left &&
    pointer.x <= bounds.right &&
    pointer.y >= bounds.top &&
    pointer.y <= bounds.bottom
  ) {
    // The pointer picks the bar's column; its line, not the bare point, is
    // what the bar keeps clear of when nothing better fits.
    const line = lines.find(
      (rect) => pointer.y >= rect.top && pointer.y <= rect.bottom,
    );
    return {
      rect:
        line === undefined
          ? new DOMRect(pointer.x, pointer.y, 0, 0)
          : new DOMRect(pointer.x, line.top, 0, line.height),
      bounds,
      extent,
    };
  }
  const end = range.cloneRange();
  end.collapse(false);
  const endRect = end.getClientRects().item(0);
  if (endRect !== null && endRect.height > 0 && visible(endRect, bounds)) {
    return { rect: endRect, bounds, extent };
  }
  const parent = range.endContainer.parentElement ?? root;
  const rtl =
    root.ownerDocument.defaultView?.getComputedStyle(parent).direction ===
    "rtl";
  const x = rtl
    ? Math.max(bounds.left, lastVisible.left)
    : Math.min(bounds.right, lastVisible.right);
  const top = Math.max(bounds.top, lastVisible.top);
  const bottom = Math.min(bounds.bottom, lastVisible.bottom);
  return { rect: new DOMRect(x, top, 0, bottom - top), bounds, extent };
};

type SelectionToolbarPositionOptions = {
  anchor: ToolbarRect;
  barWidth: number;
  barHeight: number;
  bounds: ToolbarRect;
  /** The visible selection's lines; see `SelectionToolbarAnchor.extent`. */
  extent?: SelectionToolbarExtent | undefined;
};

/**
 * The bar's top: below the whole selection, else above it, so it never sits
 * on a selected line. A selection taller than the room on either side falls
 * back to the anchor's own line, below it when it fits and above otherwise.
 */
const preferredToolbarTop = ({
  anchor,
  barHeight,
  bounds,
  extent,
}: Omit<SelectionToolbarPositionOptions, "barWidth">): number => {
  const margin = SELECTION_TOOLBAR_EDGE_MARGIN_PX;
  const offset = SELECTION_TOOLBAR_OFFSET_PX;
  const fitsBelow = (edge: number) =>
    edge + offset + barHeight <= bounds.bottom - margin;
  const fitsAbove = (edge: number) =>
    edge - offset - barHeight >= bounds.top + margin;
  if (extent !== undefined) {
    if (fitsBelow(extent.bottom)) {
      return extent.bottom + offset;
    }
    if (fitsAbove(extent.top)) {
      return extent.top - offset - barHeight;
    }
  }
  return fitsBelow(anchor.bottom)
    ? anchor.bottom + offset
    : anchor.top - offset - barHeight;
};

/** Left is the centre (the shared bar translates by half its measured width). */
export const selectionToolbarPosition = ({
  anchor,
  barWidth,
  barHeight,
  bounds,
  extent,
}: SelectionToolbarPositionOptions): { left: number; top: number } => {
  const margin = SELECTION_TOOLBAR_EDGE_MARGIN_PX;
  const halfBar = barWidth / 2;
  const minLeft = bounds.left + margin + halfBar;
  const maxLeft = Math.max(minLeft, bounds.right - margin - halfBar);
  const preferredTop = preferredToolbarTop({
    anchor,
    barHeight,
    bounds,
    extent,
  });
  const minTop = bounds.top + margin;
  const maxTop = Math.max(minTop, bounds.bottom - margin - barHeight);
  return {
    left: Math.max(
      minLeft,
      Math.min((anchor.left + anchor.right) / 2, maxLeft),
    ),
    top: Math.max(minTop, Math.min(preferredTop, maxTop)),
  };
};
