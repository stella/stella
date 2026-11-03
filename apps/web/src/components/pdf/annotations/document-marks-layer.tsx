import { createContext, use } from "react";

import { DocumentMarkBoxes } from "@/components/pdf/annotations/document-mark-boxes";
import type { DocumentMarksSurface } from "@/components/pdf/annotations/document-mark-boxes";
import { usePDFStore } from "@/lib/pdf/pdf-context";

export const DocumentMarksContext = createContext<DocumentMarksSurface | null>(
  null,
);

/**
 * One page's marks, drawn as boxes over its canvas from the glyph boxes the
 * anchors cover. The boxes are in PDF units converted with the page's own
 * viewport, so they redraw with the page whenever it re-renders at another
 * scale, and never take a press: the text layer below keeps every selection.
 * A comment under the pointer shows its words beside the first box.
 */
export const DocumentMarkPageLayer = ({ pageId }: { pageId: string }) => {
  const surface = use(DocumentMarksContext);
  const viewport = usePDFStore((state) => state.pages.get(pageId)?.viewport);
  if (surface === null || viewport === undefined) {
    return null;
  }
  const pageNumber = surface.pageNumberOf(pageId);
  return pageNumber === null ? null : (
    <DocumentMarkBoxes
      activeId={surface.activeId}
      hoveredId={surface.hoveredId}
      marks={surface.marks}
      pageNumber={pageNumber}
      viewport={viewport}
    />
  );
};
