import { useEffect, useMemo, useRef, useState } from "react";

import { useShallow } from "zustand/react/shallow";

import {
  mapEntityToSpanSlices,
  mergeAdjacentRects,
} from "@/lib/anonymize/overlay-rects";
import type { OverlayRect } from "@/lib/anonymize/overlay-rects";
import { EOC_CLASS_NAME, TEXT_LAYER_ATTRIBUTE } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";

/**
 * Compute overlay rects from the pdfjs text layer DOM
 * using the Range API. Rects are measured once and stored
 * as normalized (PDF-space) coordinates, then scaled to
 * the current viewport on each render.
 */
export const useOverlayRects = (
  pageId: string,
  pageIndex: number,
): Map<number, OverlayRect[]> | null => {
  const overlays = usePDFStore(
    useShallow((s) => s.fileAnonymization?.perPage.get(pageIndex)),
  );

  const charSpans = usePDFStore((s) => s.fileAnonymization?.charSpans);

  const scale = usePDFStore((s) => s.pages.get(pageId)?.viewport.scale);

  // eslint-disable-next-line typescript-eslint/promise-function-async -- store selector returns promise as value, not as async result
  const renderPromise = usePDFStore((s) => s.renderPromises.get(pageId));

  const [normalizedRects, setNormalizedRects] = useState<Map<
    number,
    OverlayRect[]
  > | null>(null);

  const prevOverlaysRef = useRef(overlays);
  if (prevOverlaysRef.current !== overlays) {
    prevOverlaysRef.current = overlays;
    if (normalizedRects !== null) {
      setNormalizedRects(null);
    }
  }

  useEffect(() => {
    if (normalizedRects) {
      return;
    }
    if (
      !overlays ||
      overlays.length === 0 ||
      !charSpans ||
      scale === undefined
    ) {
      return;
    }

    const textLayerEl = document.querySelector(
      `[${TEXT_LAYER_ATTRIBUTE}="${pageId}"]`,
    );
    if (!textLayerEl) {
      return;
    }

    const domSpans = [...textLayerEl.children].filter(
      (el): el is HTMLSpanElement =>
        el.tagName === "SPAN" && !el.classList.contains(EOC_CLASS_NAME),
    );

    const pageSpans = charSpans.filter((s) => s.bbox.pageIndex === pageIndex);

    const containerRect = textLayerEl.getBoundingClientRect();
    const invScale = 1 / scale;
    const result = new Map<number, OverlayRect[]>();

    for (const entity of overlays) {
      const rects: OverlayRect[] = [];

      for (const entitySpan of entity.spans) {
        if (entitySpan.pageIndex !== pageIndex) {
          continue;
        }

        const slices = mapEntityToSpanSlices({
          pageSpans,
          entityStart: entitySpan.start,
          entityEnd: entitySpan.end,
        });

        for (const slice of slices) {
          const domSpan = domSpans[slice.spanIndex];
          const textNode = domSpan?.firstChild;
          if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
            continue;
          }

          const range = document.createRange();
          range.setStart(textNode, slice.localStart);
          range.setEnd(textNode, slice.localEnd);

          for (const r of range.getClientRects()) {
            rects.push({
              left: (r.left - containerRect.left) * invScale,
              top: (r.top - containerRect.top) * invScale,
              width: r.width * invScale,
              height: r.height * invScale,
            });
          }
        }
      }

      if (rects.length > 0) {
        result.set(entity.id, mergeAdjacentRects(rects));
      }
    }

    setNormalizedRects(result);
  }, [
    normalizedRects,
    overlays,
    charSpans,
    pageId,
    pageIndex,
    renderPromise,
    scale,
  ]);

  return useMemo(() => {
    if (!normalizedRects || scale === undefined) {
      return null;
    }

    const scaled = new Map<number, OverlayRect[]>();
    for (const [id, rects] of normalizedRects) {
      scaled.set(
        id,
        rects.map((r) => ({
          left: r.left * scale,
          top: r.top * scale,
          width: r.width * scale,
          height: r.height * scale,
        })),
      );
    }
    return scaled;
  }, [normalizedRects, scale]);
};
