import { useState } from "react";

import { useObservedValue } from "../effects/dom";
import { resolveInlineOverflow } from "../lib/inline-overflow";

/**
 * Marks one item's natural-width copy inside the measuring row; its value is
 * the item's key.
 */
export const INLINE_OVERFLOW_ITEM_ATTRIBUTE = "data-inline-overflow-item";
/** Marks the overflow trigger's copy inside the measuring row. */
export const INLINE_OVERFLOW_TRIGGER_ATTRIBUTE = "data-inline-overflow-trigger";

/** Joins item keys into one value the effect can depend on. */
const KEY_SEPARATOR = "\u0000";

/**
 * The space between two neighbouring copies, read off their boxes in either
 * reading direction; the copies sit in one row, so it is the row's gap.
 */
const itemGap = (items: readonly DOMRect[]): number => {
  const [first, second] = items;
  if (first === undefined || second === undefined) {
    return 0;
  }
  return Math.max(0, second.left - first.right, first.left - second.right);
};

type UseInlineOverflowOptions = {
  /** The active item's index; the policy keeps it on screen. */
  activeIndex: number;
  /**
   * Each item's key, in display order; the measuring copy of an item carries
   * its key in `INLINE_OVERFLOW_ITEM_ATTRIBUTE`.
   */
  itemKeys: readonly string[];
};

/**
 * Measures a single-line row and decides how many of its items fit, by
 * `resolveInlineOverflow`. The caller renders two things:
 *
 * - the row (`containerRef`), whose box is the room the items and the
 *   overflow trigger share, independent of how many items it shows. It
 *   carries no inline padding or border of its own (an inset belongs on a
 *   wrapper), so its client rect is that room, in the copies' own units;
 * - an invisible, inert copy of every item at its natural width plus the
 *   trigger (`measureRef`), each marked with `INLINE_OVERFLOW_ITEM_ATTRIBUTE`
 *   (set to the item's key) or `INLINE_OVERFLOW_TRIGGER_ATTRIBUTE`, inside
 *   one flex row whose gap is the gap between items.
 *
 * Measuring the copy keeps the widths stable however many items the row is
 * currently showing, so collapsing an item never changes the measurement
 * that collapsed it. Widths are read by key in the order `itemKeys` gives,
 * and the count is recomputed whenever either element resizes (a docked
 * pane narrows the row, an added view or a rename widens the copy), the
 * active item changes, or the items change order: swapping two items keeps
 * the measuring row's size, which no observer reports.
 *
 * The first count is taken before paint (`useObservedValue` subscribes in a
 * layout effect), in the same task that commits the row: a `ResizeObserver` reports only at the browser's next rendering
 * update, and until that count lands the row would hold every item, the last
 * ones clipped, for a paint or any script that reads the layout to see.
 */
export const useInlineOverflow = ({
  activeIndex,
  itemKeys,
}: UseInlineOverflowOptions) => {
  const itemCount = itemKeys.length;
  const order = itemKeys.join(KEY_SEPARATOR);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [measure, setMeasure] = useState<HTMLElement | null>(null);
  // How many items fit, once the row has been measured; `null` until then.
  const measuredCount = useObservedValue<HTMLElement, number | null>(
    container,
    (row, emit) => {
      if (measure === null) {
        return () => undefined;
      }

      const keys = order === "" ? [] : order.split(KEY_SEPARATOR);

      const recompute = () => {
        const copies = Array.from(
          measure.querySelectorAll(`[${INLINE_OVERFLOW_ITEM_ATTRIBUTE}]`),
          (copy) => ({
            key: copy.getAttribute(INLINE_OVERFLOW_ITEM_ATTRIBUTE),
            box: copy.getBoundingClientRect(),
          }),
        );
        const boxByKey = new Map(copies.map(({ key, box }) => [key, box]));
        const trigger = measure.querySelector(
          `[${INLINE_OVERFLOW_TRIGGER_ATTRIBUTE}]`,
        );

        emit(
          resolveInlineOverflow({
            activeIndex,
            availableWidth: row.getBoundingClientRect().width,
            gap: itemGap(copies.map(({ box }) => box)),
            itemWidths: keys.map((key) => boxByKey.get(key)?.width ?? 0),
            triggerWidth: trigger?.getBoundingClientRect().width ?? 0,
          }).visibleCount,
        );
      };

      recompute();
      // Later changes (a docked pane narrows the row, a web font or a rename
      // widens the copy) arrive through the observer.
      const observer = new ResizeObserver(recompute);
      observer.observe(row);
      observer.observe(measure);
      return () => observer.disconnect();
    },
    [activeIndex, measure, order],
    null,
  );

  return {
    /** The measured row, once mounted. */
    container,
    containerRef: setContainer,
    /** Whether the row has been measured; until then every item shows. */
    measured: measuredCount !== null,
    measureRef: setMeasure,
    visibleCount: Math.min(measuredCount ?? itemCount, itemCount),
  };
};
