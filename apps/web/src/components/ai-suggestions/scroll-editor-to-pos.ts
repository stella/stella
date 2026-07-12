import type { EditorView } from "prosemirror-view";

import { scrollFolioPositionIntoView } from "@stll/folio-react";

/**
 * Scroll the document so the given PM position is centered in view.
 *
 * Folio's paged editor keeps its editing PM view hidden off-screen;
 * `coordsAtPos` on that view yields coordinates of the hidden mirror,
 * not the visible pages — scrolling by them moves a near-constant step
 * per call instead of jumping to the target. Prefer the paged-layout
 * scroll (anchors on the painted pages, page shells under
 * virtualization); fall back to coordinate math only when no paged
 * layout is mounted around the view.
 */
export function scrollEditorToPos(view: EditorView, pos: number): void {
  if (scrollFolioPositionIntoView(view, pos)) {
    return;
  }
  const scrollContainer = view.dom.closest("[data-folio-scroll]");
  if (scrollContainer === null) {
    return;
  }
  const coords = view.coordsAtPos(pos);
  const rect = scrollContainer.getBoundingClientRect();
  const targetTop = coords.top - rect.top + scrollContainer.scrollTop;
  scrollContainer.scrollTo({
    top: targetTop - rect.height / 3,
    behavior: "smooth",
  });
}
