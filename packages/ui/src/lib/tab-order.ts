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
export const hasTabOrderChanged = <T>(
  previous: readonly T[],
  next: readonly T[],
): boolean =>
  previous.length !== next.length ||
  next.some((tab, index) => tab !== previous[index]);
