/**
 * Whether a committed tab list holds different elements, or the same elements
 * in a different order, than the previous commit.
 *
 * Base UI measures the tabs indicator during render, so it reads the DOM as it
 * stood before the commit. Its correction is a `ResizeObserver`, which catches
 * an insertion or a removal (the list's own width changes) but not a reorder:
 * there the tabs swap places without anything changing size. Detecting that is
 * the whole of the workaround, so compare identity rather than count, because
 * React moves the same nodes when it reorders keyed children.
 */
type TabEdges = { left: number; right: number };

type TabStrip = {
  scrollLeft: number;
  getBoundingClientRect: () => TabEdges;
  querySelector: (selector: string) => {
    getBoundingClientRect: () => TabEdges;
  } | null;
};

/**
 * Brings the active tab back inside a horizontal strip that scrolled it out of
 * view. Moves the strip only, never an ancestor, and works from rendered edges
 * so a right-to-left strip needs no separate case.
 */
export const revealActiveTab = (list: TabStrip) => {
  const active = list.querySelector('[role="tab"][aria-selected="true"]');
  if (active === null) {
    return;
  }
  const strip = list.getBoundingClientRect();
  const tab = active.getBoundingClientRect();
  if (tab.left < strip.left) {
    list.scrollLeft -= strip.left - tab.left;
  } else if (tab.right > strip.right) {
    list.scrollLeft += tab.right - strip.right;
  }
};

export const hasTabOrderChanged = <T>(
  previous: readonly T[],
  next: readonly T[],
): boolean =>
  previous.length !== next.length ||
  next.some((tab, index) => tab !== previous[index]);
