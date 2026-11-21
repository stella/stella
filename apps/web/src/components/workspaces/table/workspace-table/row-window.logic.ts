/**
 * Which rows the table body paints, and the filler above and below them.
 *
 * The window is the virtualizer's whenever it has one. It has none while its
 * scroll element measures zero height: TanStack Virtual's range is null for an
 * outer size of 0, so `getVirtualItems()` comes back empty. That is the state
 * of every first render, of a container whose height only arrives with a later
 * layout pass, and of one that is laid out while hidden. A body that maps over
 * that window alone paints no row at all, while the bottom filler still
 * reserves the full height of the rows it is not drawing — a table that has
 * its rows, and shows none of them.
 *
 * So an empty window over a non-empty row set is not "no rows": it is "not
 * measured yet". The body paints the first rows, the virtualizer takes the
 * window over from its next measurement, and the empty state stays the answer
 * to an empty row set only.
 */

/** What the body needs of a virtual row; the virtualizer's items satisfy it. */
type VirtualRowExtent = {
  index: number;
  start: number;
  end: number;
};

type TableRowWindowInput = {
  /** The virtualizer's window, empty while its scroll element is unmeasured. */
  virtualRows: readonly VirtualRowExtent[];
  /** Rows the table has; the window never reaches past them. */
  rowCount: number;
  /** `getTotalSize()`: the height the rows claim in the scroll. */
  totalSize: number;
  /**
   * The virtualizer's scroll margin. A virtual row's `start` is measured from
   * the start of the scroll and includes it, while the rows container already
   * sits at that offset in the DOM flow — so it comes off the top filler and
   * goes back onto the bottom one. Both reduce to the plain formulas at 0,
   * which is what a table owning its own scroll passes.
   */
  scrollMargin: number;
  /** The per-row height the virtualizer estimates before it measures one. */
  estimatedRowPx: number;
};

export type TableRowWindow = {
  /** Indexes into the row model, in paint order. */
  indexes: number[];
  paddingTop: number;
  paddingBottom: number;
};

/**
 * Rows drawn before the scroll container has been measured. Bounded because an
 * unmeasured container cannot say how many rows fit on screen, and mounting
 * every row of a page to answer that would cost more than the gap it closes;
 * the measurement that replaces this window is one layout pass away.
 */
export const UNMEASURED_WINDOW_ROW_COUNT = 16;

export const tableRowWindow = ({
  virtualRows,
  rowCount,
  totalSize,
  scrollMargin,
  estimatedRowPx,
}: TableRowWindowInput): TableRowWindow => {
  const first = virtualRows.at(0);
  const last = virtualRows.at(-1);

  if (!first || !last) {
    const count = Math.min(rowCount, UNMEASURED_WINDOW_ROW_COUNT);
    return {
      indexes: Array.from({ length: count }, (_unused, index) => index),
      paddingTop: 0,
      paddingBottom: Math.max(0, totalSize - count * estimatedRowPx),
    };
  }

  return {
    indexes: virtualRows.map((virtualRow) => virtualRow.index),
    paddingTop: first.start - scrollMargin,
    paddingBottom: totalSize - last.end + scrollMargin,
  };
};

/** What `measureFlowRow` needs of the virtualizer. */
type RowSizeSource<TElement extends Element> = {
  indexFromElement: (element: TElement) => number;
  itemSizeCache: ReadonlyMap<unknown, number>;
  options: {
    getItemKey: (index: number) => unknown;
    estimateSize: (index: number) => number;
  };
};

/**
 * A row's height for the virtualizer, read from its ResizeObserver entry.
 *
 * The rows sit in normal flow, so a height only sizes the filler below the
 * window and never moves a drawn row. The virtualizer also measures each row
 * as React attaches it (no entry); reading the DOM there forces the browser to
 * lay the whole table out once per row while the mount commits. That path
 * answers with what is already known, the row's last measured height or the
 * estimate, and the observer's first entry, delivered after layout and before
 * paint, gives the real one.
 */
export const measureFlowRow = <TElement extends Element>(
  element: TElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: RowSizeSource<TElement>,
) => {
  const box = entry?.borderBoxSize.at(0);
  if (box !== undefined) {
    return box.blockSize;
  }
  const index = virtualizer.indexFromElement(element);
  return (
    virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) ??
    virtualizer.options.estimateSize(index)
  );
};
