import { useShallow } from "zustand/react/shallow";

import { projectOverlayRects } from "@/lib/anonymize/overlay-rects";
import type { OverlayRect } from "@/lib/anonymize/overlay-rects";
import { usePDFStore } from "@/lib/pdf/pdf-context";

/** The anonymization overlay rectangles of one page at its current zoom. */
export const useOverlayRects = (
  pageId: string,
  pageIndex: number,
): Map<number, OverlayRect[]> | null => {
  const entities = usePDFStore(
    useShallow((s) => s.fileAnonymization?.perPage.get(pageIndex)),
  );
  const viewport = usePDFStore((s) => s.pages.get(pageId)?.viewport);

  if (entities === undefined || viewport === undefined) {
    return null;
  }
  return projectOverlayRects({ entities, pageIndex, viewport });
};
