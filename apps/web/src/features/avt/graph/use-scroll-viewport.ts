import { useState } from "react";

import { useObservedValue } from "@stll/ui/effects-dom";

/** The visible band of a scrolling element: how far it is scrolled, and its
 *  size. Zero until it is measured, and where sizes cannot be observed. */
export type ScrollViewport = { top: number; width: number; height: number };

const UNMEASURED: ScrollViewport = { top: 0, width: 0, height: 0 };

/**
 * Follows a scrolling element's position and size, for drawing only what
 * can be seen. Hand the ref to the element that scrolls (a ScrollArea's
 * `viewportRef`).
 */
export const useScrollViewport = () => {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  // An unchanged band keeps the same value, so an observer that fires on
  // every layout (as the canvas redraws) cannot feed itself.
  const viewport = useObservedValue<HTMLDivElement, ScrollViewport>(
    node,
    (observed, emit) => {
      const measure = () => {
        emit({
          top: observed.scrollTop,
          width: observed.clientWidth,
          height: observed.clientHeight,
        });
      };
      observed.addEventListener("scroll", measure, { passive: true });
      const observer =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(measure);
      observer?.observe(observed);
      return () => {
        observed.removeEventListener("scroll", measure);
        observer?.disconnect();
      };
    },
    [],
    UNMEASURED,
  );
  return [setNode, viewport] as const;
};
