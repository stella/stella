import { useCallback } from "react";
import type { RefCallback, RefObject } from "react";

import { useShallow } from "zustand/react/shallow";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { SCROLL_AREA_VIEWPORT_SELECTOR } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { restoreScrollAnchor } from "@/lib/pdf/utils";

type UsePDFFitToWidthArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
};

export const usePDFFitToWidth = ({
  containerRef,
}: UsePDFFitToWidthArgs): RefCallback<HTMLDivElement> => {
  const [
    fitToWidth,
    scaleOffset,
    updateContainerWidth,
    consumePendingScrollAnchor,
  ] = usePDFStore(
    useShallow((s) => [
      s.fitToWidth,
      s.scaleOffset,
      s.updateContainerWidth,
      s.consumePendingScrollAnchor,
    ]),
  );
  const effectiveScale = usePDFStore(
    useShallow((s) => s.scale + s.scaleOffset),
  );

  useExternalSyncEffect(() => {
    const anchor = consumePendingScrollAnchor();

    if (anchor) {
      const scrollViewport = containerRef.current?.closest<HTMLElement>(
        SCROLL_AREA_VIEWPORT_SELECTOR,
      );
      if (scrollViewport) {
        restoreScrollAnchor(scrollViewport, anchor);
      }
    }

    return undefined;
  }, [consumePendingScrollAnchor, containerRef, effectiveScale]);

  return useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || fitToWidth === undefined || scaleOffset !== 0) {
        return undefined;
      }

      // Observe the ScrollArea viewport (the visible area),
      // not the content container. The content container's
      // width is determined by the PDF pages themselves,
      // creating a circular dependency.
      const viewport = container.closest<HTMLElement>(
        SCROLL_AREA_VIEWPORT_SELECTOR,
      );
      const observeTarget = viewport ?? container;

      // Every `observe` reports the current size once, and the viewer
      // re-attaches this ref whenever its page list changes, so the same
      // width arrives again and again. The store redraws pages only when the
      // width changes the scale.
      const observer = new ResizeObserver((entries) => {
        const entry = entries.at(-1);
        if (!entry) {
          return;
        }

        const containerWidth = entry.contentRect.width;
        if (containerWidth <= 0) {
          return;
        }

        updateContainerWidth(containerWidth, container);
      });

      observer.observe(observeTarget);

      return () => {
        observer.disconnect();
      };
    },
    [fitToWidth, scaleOffset, updateContainerWidth],
  );
};
