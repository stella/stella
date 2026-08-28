import { useEffect, useState } from "react";
import type { RefObject } from "react";

export type RailViewport = {
  scrollLeft: number;
  /** 0 until the rail has been measured. */
  width: number;
};

const INITIAL_VIEWPORT: RailViewport = { scrollLeft: 0, width: 0 };

/**
 * Scroll offset and width of a horizontal rail, coalesced to one update per
 * frame. `mounted` must flip when the rail element is (un)mounted so the
 * listeners attach to the current node.
 */
export const useRailViewport = (
  rail: RefObject<HTMLDivElement | null>,
  mounted: boolean,
): RailViewport => {
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);

  useEffect(() => {
    const node = rail.current;
    if (!mounted || !node) {
      return () => undefined;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      setViewport((current) => {
        const next = { scrollLeft: node.scrollLeft, width: node.clientWidth };
        return current.scrollLeft === next.scrollLeft &&
          current.width === next.width
          ? current
          : next;
      });
    };
    const scheduleMeasure = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(measure);
      }
    };
    measure();
    node.addEventListener("scroll", scheduleMeasure, { passive: true });
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", scheduleMeasure);
      observer.disconnect();
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [mounted, rail]);

  return viewport;
};
