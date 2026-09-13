import { useCallback, useState, useSyncExternalStore } from "react";

export type RailViewport = {
  /** Distance scrolled from the rail's inline start. An RTL rail reports a
   *  negative `scrollLeft`, so the magnitude is what both directions share. */
  scrollOffset: number;
  /** 0 until the rail has been measured. */
  width: number;
};

type RailViewportHandle = {
  /** Ref callback for the rail element; stable, so React attaches it once. */
  railRef: (node: HTMLDivElement | null) => void;
  viewport: RailViewport;
};

/**
 * Scroll offset and width of a horizontal rail.
 *
 * The cards mounted in the rail derive from this viewport, so a viewport
 * that lags the DOM paints a blank rail. The rail is read as an external
 * store: every render reads the DOM directly, and React re-renders when the
 * value read during render no longer matches the DOM at commit. A scroll
 * the listeners never heard about (one applied while the window was parked)
 * is therefore reconciled by the next commit, and scroll and resize events
 * are read synchronously, since both already arrive once per rendering
 * update and a deferred read would only lose them while parked.
 */
export const useRailViewport = (): RailViewportHandle => {
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!node) {
        return () => undefined;
      }
      node.addEventListener("scroll", onChange, { passive: true });
      const observer = new ResizeObserver(onChange);
      observer.observe(node);
      return () => {
        node.removeEventListener("scroll", onChange);
        observer.disconnect();
      };
    },
    [node],
  );

  const scrollOffset = useSyncExternalStore(subscribe, () =>
    node ? Math.abs(node.scrollLeft) : 0,
  );
  const width = useSyncExternalStore(subscribe, () => node?.clientWidth ?? 0);

  return { railRef: setNode, viewport: { scrollOffset, width } };
};
