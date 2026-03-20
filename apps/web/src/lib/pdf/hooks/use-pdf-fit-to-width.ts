import { useEffect } from "react";
import type { RefObject } from "react";

import { useDebouncedCallback } from "use-debounce";
import { useShallow } from "zustand/react/shallow";

import { usePDFStore } from "@/lib/pdf/pdf-context";

type UsePDFFitToWidthArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
  isHydrated: boolean;
};

export const usePDFFitToWidth = ({
  containerRef,
  isHydrated,
}: UsePDFFitToWidthArgs) => {
  const [
    fitToWidth,
    scale,
    scaleOffset,
    updateContainerWidth,
    rerenderAtScale,
  ] = usePDFStore(
    useShallow((s) => [
      s.fitToWidth,
      s.scale,
      s.scaleOffset,
      s.updateContainerWidth,
      s.rerenderAtScale,
    ]),
  );

  const effectiveScale = scale + scaleOffset;
  const debouncedRerender = useDebouncedCallback(rerenderAtScale, 150);

  useEffect(() => {
    if (fitToWidth === undefined || scaleOffset !== 0 || !isHydrated) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
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

    observer.observe(container);

    return () => {
      observer.disconnect();
      debouncedRerender.cancel();
    };
  }, [
    fitToWidth,
    isHydrated,
    scaleOffset,
    effectiveScale,
    updateContainerWidth,
    debouncedRerender,
    containerRef,
  ]);
};
