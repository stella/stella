import * as React from "react";

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
  const [viewport, setViewport] = React.useState<ScrollViewport>(UNMEASURED);
  const ref = React.useCallback((node: HTMLDivElement | null) => {
    if (node === null) {
      return undefined;
    }
    // An unchanged band keeps the same state, so an observer that fires on
    // every layout (as the canvas redraws) cannot feed itself.
    const measure = () => {
      const next = {
        top: node.scrollTop,
        width: node.clientWidth,
        height: node.clientHeight,
      };
      setViewport((current) =>
        current.top === next.top &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    node.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);
  return [ref, viewport] as const;
};
