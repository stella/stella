import { useEffect } from "react";
import type { RefObject } from "react";

import { useDebouncedCallback } from "use-debounce";
import { useShallow } from "zustand/react/shallow";

import { SCROLL_AREA_VIEWPORT_SELECTOR } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { restoreScrollAnchor } from "@/lib/pdf/utils";

type UsePDFFitToWidthArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
};

export const usePDFFitToWidth = ({ containerRef }: UsePDFFitToWidthArgs) => {
  const [
    fitToWidth,
    scaleOffset,
    updateContainerWidth,
    rerenderAtScale,
    consumePendingScrollAnchor,
  ] = usePDFStore(
    useShallow((s) => [
      s.fitToWidth,
      s.scaleOffset,
      s.updateContainerWidth,
      s.rerenderAtScale,
      s.consumePendingScrollAnchor,
    ]),
  );
  const effectiveScale = usePDFStore(
    useShallow((s) => s.scale + s.scaleOffset),
  );
  const debouncedRerender = useDebouncedCallback(rerenderAtScale, 150);

  useEffect(() => {
    const anchor = consumePendingScrollAnchor();

    if (anchor) {
      const scrollViewport = containerRef.current?.closest<HTMLElement>(
        SCROLL_AREA_VIEWPORT_SELECTOR,
      );
      if (scrollViewport) {
        restoreScrollAnchor(scrollViewport, anchor);
      }
    }

    if (fitToWidth === undefined || scaleOffset !== 0) {
      return undefined;
    }

    const container = containerRef.current;
    if (!container) {
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

    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(0);
      if (!entry) {
        return;
      }

      const containerWidth = entry.contentRect.width;
      if (containerWidth <= 0) {
        return;
      }

      updateContainerWidth(containerWidth, container);
      debouncedRerender(effectiveScale);
    });

    observer.observe(observeTarget);

    return () => {
      observer.disconnect();
      debouncedRerender.cancel();
    };
  }, [
    fitToWidth,
    scaleOffset,
    effectiveScale,
    updateContainerWidth,
    consumePendingScrollAnchor,
    debouncedRerender,
    containerRef,
  ]);
};
