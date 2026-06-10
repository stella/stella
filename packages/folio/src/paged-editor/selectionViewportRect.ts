/**
 * Viewport rectangle of the painted text selection.
 *
 * The paged editor's editing PM view is hidden off-screen
 * (HiddenProseMirror); the selection the user sees is painted by
 * SelectionOverlay as highlight divs inside the zoom-scaled pages
 * viewport. Hosts anchoring floating UI to the selection (popovers,
 * floating toolbars) therefore cannot use `view.coordsAtPos` — those
 * coordinates belong to the hidden, unpaginated mirror, not the pages
 * the user sees. This module reads the painted highlight rects instead
 * and returns their union in client (viewport) coordinates, which
 * already include zoom and scroll.
 */

import type { EditorView } from "prosemirror-view";

/** Attribute SelectionOverlay stamps on every painted highlight rect. */
export const FOLIO_SELECTION_RECT_ATTRIBUTE = "data-folio-selection-rect";

/**
 * Union bounding rect (client coordinates) of the painted selection
 * highlights mirroring `view`'s selection. Returns null for a collapsed
 * selection or while the overlay has not painted yet — the selection
 * geometry is computed asynchronously after each selection change, so
 * callers should retry on a later frame instead of treating null as
 * "no selection".
 */
export const getFolioSelectionViewportRect = (
  view: EditorView,
): DOMRect | null => {
  const scrollContainer = view.dom.closest("[data-folio-scroll]");
  if (!scrollContainer) {
    return null;
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let found = false;
  const highlights = scrollContainer.querySelectorAll<HTMLElement>(
    `[${FOLIO_SELECTION_RECT_ATTRIBUTE}]`,
  );
  for (const el of highlights) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    found = true;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!found) {
    return null;
  }
  return new DOMRect(left, top, right - left, bottom - top);
};
