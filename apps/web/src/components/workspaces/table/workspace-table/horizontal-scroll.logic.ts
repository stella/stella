/**
 * Where the table's horizontal scroll belongs after a layout pass.
 *
 * Two independent widths move the scrollable range, and they deserve opposite
 * answers. When the grid changes width (a column resized, hidden or added) a
 * reader parked at the end edge stays at the end edge. When the viewport
 * changes width (an inspector dock opening beside the table, the sidebar
 * collapsing, the window resizing) the reader's own columns must stay under
 * their eyes: the offset is kept, and the range is only clamped if the old
 * offset no longer fits.
 *
 * Conflating the two is what makes a narrowing viewport yank the table to its
 * end edge, because an unscrolled table is also at its end edge whenever the
 * grid fits — every reader who has scrolled nowhere satisfies the pinning
 * test.
 */

export type HorizontalScrollMetrics = {
  /** Combined inline size of the grid's columns. */
  tableWidth: number;
  /** Inline size of the scroll viewport the grid sits in. */
  wrapperWidth: number;
};

/** Slack for a sub-pixel offset that is a reader sitting on the end edge. */
const END_EDGE_TOLERANCE_PX = 2;

export const horizontalMaxScroll = ({
  tableWidth,
  wrapperWidth,
}: HorizontalScrollMetrics): number => Math.max(0, tableWidth - wrapperWidth);

type HorizontalScrollAnchorInput = {
  /** Metrics this layout pass produced. */
  next: HorizontalScrollMetrics;
  /** Metrics the previous pass produced; null before the first measurement. */
  previous: HorizontalScrollMetrics | null;
  /** The container's current offset, as the DOM reports it. */
  scrollLeft: number;
};

/**
 * The offset to write, or null to leave the container alone. Null is the
 * common answer and the reason this returns one: the browser already keeps a
 * scroll offset across a reflow, so anchoring means writing nothing.
 *
 * Offsets are read on the physical axis, the way `scrollLeft` reports them. An
 * RTL container reports a negative offset, which no branch here matches, so it
 * falls through to leaving the scroll alone — the anchored outcome either way.
 */
export const anchoredHorizontalScroll = ({
  next,
  previous,
  scrollLeft,
}: HorizontalScrollAnchorInput): number | null => {
  if (previous === null) {
    return null;
  }

  const maxScroll = horizontalMaxScroll(next);
  const clamped = scrollLeft > maxScroll ? maxScroll : null;

  if (previous.wrapperWidth !== next.wrapperWidth) {
    return clamped;
  }

  const wasAtEndEdge =
    scrollLeft >= horizontalMaxScroll(previous) - END_EDGE_TOLERANCE_PX;
  if (!wasAtEndEdge) {
    return clamped;
  }

  return scrollLeft === maxScroll ? null : maxScroll;
};
