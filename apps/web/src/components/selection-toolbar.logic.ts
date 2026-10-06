/** Gap between the selected line and its actions. */
export const SELECTION_TOOLBAR_OFFSET_PX = 8;
/** The least the bar keeps between itself and a clipping edge. */
export const SELECTION_TOOLBAR_EDGE_MARGIN_PX = 8;

type ToolbarRect = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

export type SelectionToolbarAnchor = {
  rect: DOMRect;
  bounds: DOMRect;
};

const clips = (overflow: string): boolean => overflow !== "visible";

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
  for (const rect of range.getClientRects()) {
    if (rect.height > 0 && visible(rect, bounds)) {
      lastVisible = rect;
    }
  }
  if (lastVisible === null) {
    return null;
  }
  if (
    pointer !== undefined &&
    pointer.x >= bounds.left &&
    pointer.x <= bounds.right &&
    pointer.y >= bounds.top &&
    pointer.y <= bounds.bottom
  ) {
    return { rect: new DOMRect(pointer.x, pointer.y, 0, 0), bounds };
  }
  const end = range.cloneRange();
  end.collapse(false);
  const endRect = end.getClientRects().item(0);
  if (endRect !== null && endRect.height > 0 && visible(endRect, bounds)) {
    return { rect: endRect, bounds };
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
  return { rect: new DOMRect(x, top, 0, bottom - top), bounds };
};

type SelectionToolbarPositionOptions = {
  anchor: ToolbarRect;
  barWidth: number;
  barHeight: number;
  bounds: ToolbarRect;
};

/** Left is the centre (the shared bar translates by half its measured width). */
export const selectionToolbarPosition = ({
  anchor,
  barWidth,
  barHeight,
  bounds,
}: SelectionToolbarPositionOptions): { left: number; top: number } => {
  const margin = SELECTION_TOOLBAR_EDGE_MARGIN_PX;
  const halfBar = barWidth / 2;
  const minLeft = bounds.left + margin + halfBar;
  const maxLeft = Math.max(minLeft, bounds.right - margin - halfBar);
  const below = anchor.bottom + SELECTION_TOOLBAR_OFFSET_PX;
  const preferredTop =
    below + barHeight <= bounds.bottom - margin
      ? below
      : anchor.top - SELECTION_TOOLBAR_OFFSET_PX - barHeight;
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
