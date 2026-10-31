/**
 * Fades a horizontal scroller's edges while content continues past them.
 *
 * A mask, not a painted gradient: it works over any background, including
 * translucent windows. `--fade-size` sets the width (as in `ScrollArea`); the
 * measured overflow at each physical edge narrows it, so an edge with nothing
 * behind it stays sharp.
 */
export const SCROLL_EDGE_FADE_CLASS =
  "mask-l-from-[calc(100%-min(var(--fade-size,1.5rem),var(--scroll-fade-left,0px)))] mask-r-from-[calc(100%-min(var(--fade-size,1.5rem),var(--scroll-fade-right,0px)))]";

/** Above any `--fade-size` in use; CSS takes the smaller of the two. */
const MAX_FADE_PX = 64;

const fadeWidth = (overflow: number) =>
  `${Math.min(Math.max(overflow, 0), MAX_FADE_PX)}px`;

const writeProperty = (node: HTMLElement, name: string, value: string) => {
  // Widths are capped, so scrolling through the middle writes nothing and the
  // mask is not recomputed on every frame.
  if (node.style.getPropertyValue(name) !== value) {
    node.style.setProperty(name, value);
  }
};

/**
 * Measures `node` and writes the overflow its `SCROLL_EDGE_FADE_CLASS` reads.
 * For a scroller that already measures itself on scroll and resize.
 */
export const writeScrollEdgeFade = (node: HTMLElement) => {
  const maximum = node.scrollWidth - node.clientWidth;
  // A right-to-left scroller runs from 0 at its right edge down to -maximum.
  const fromLeft =
    getComputedStyle(node).direction === "rtl"
      ? maximum + node.scrollLeft
      : node.scrollLeft;
  writeProperty(node, "--scroll-fade-left", fadeWidth(fromLeft));
  writeProperty(node, "--scroll-fade-right", fadeWidth(maximum - fromLeft));
};

/**
 * Ref callback keeping `writeScrollEdgeFade` current for a scroller that does
 * not measure itself. Content can move the end without a scroll or resize (an
 * item added, removed or relabelled), so mutations re-measure too, once per
 * frame.
 */
export const fadeScrollEdges = (node: HTMLElement | null) => {
  if (!node) {
    return undefined;
  }
  let frame = 0;
  const measure = () => {
    frame = 0;
    writeScrollEdgeFade(node);
  };
  const schedule = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(measure);
    }
  };
  measure();
  node.addEventListener("scroll", schedule, { passive: true });
  const resizes = new ResizeObserver(schedule);
  resizes.observe(node);
  const mutations = new MutationObserver(schedule);
  // Inline styles carry virtualized spacer widths.
  mutations.observe(node, {
    attributeFilter: ["style"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  return () => {
    cancelAnimationFrame(frame);
    node.removeEventListener("scroll", schedule);
    resizes.disconnect();
    mutations.disconnect();
  };
};
