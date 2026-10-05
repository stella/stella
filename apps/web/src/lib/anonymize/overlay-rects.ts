import { panic } from "better-result";

import type { EntityOverlay } from "@/lib/pdf/anonymization-types";
import { toPDFSearchViewportBox } from "@/lib/pdf/pdf-search";
import type { PageViewport } from "@/lib/pdf/pdfjs-loader";

export type OverlayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type OverlayRectKeyInput = {
  entityId: number;
  rect: OverlayRect;
};

export const getOverlayRectKey = ({
  entityId,
  rect,
}: OverlayRectKeyInput): string =>
  `${entityId}:${rect.left}:${rect.top}:${rect.width}:${rect.height}`;

type ProjectOverlayRectsOptions = {
  entities: readonly EntityOverlay[];
  pageIndex: number;
  viewport: Pick<PageViewport, "convertToViewportPoint">;
};

/**
 * The overlay rectangles of a page at its current viewport. They are the
 * entities' glyph boxes, the ones the redacted export masks, projected the
 * way search highlights are; nothing is measured from the rendered text
 * layer, so what the overlay covers cannot drift from what the export hides.
 */
export const projectOverlayRects = ({
  entities,
  pageIndex,
  viewport,
}: ProjectOverlayRectsOptions): Map<number, OverlayRect[]> => {
  const rects = new Map<number, OverlayRect[]>();
  for (const entity of entities) {
    const boxes = entity.boxesByPage.get(pageIndex);
    if (boxes === undefined) {
      continue;
    }
    const projected: OverlayRect[] = [];
    for (const box of boxes) {
      const rect = toPDFSearchViewportBox(box, viewport);
      if (rect === null) {
        return panic("A page viewport returned a non-numeric point");
      }
      projected.push(rect);
    }
    rects.set(entity.id, projected);
  }
  return rects;
};
