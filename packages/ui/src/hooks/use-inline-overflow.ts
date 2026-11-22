import { useEffect, useState } from "react";

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
 * - the row (`containerRef`), whose content box is the room the items and
 *   the overflow trigger share, independent of how many items it shows;
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
 * the measuring row's size, which no observer reports. The first count
 * arrives with the observer's first report, before the row paints; until
 * then every item shows.
 */
export const useInlineOverflow = ({
  activeIndex,
  itemKeys,
}: UseInlineOverflowOptions) => {
  const itemCount = itemKeys.length;
  const order = itemKeys.join(KEY_SEPARATOR);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [measure, setMeasure] = useState<HTMLElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(itemCount);
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    if (!container || !measure) {
      return undefined;
    }

    const keys = order === "" ? [] : order.split(KEY_SEPARATOR);
    // The row's content box as its observer reports it: the room inside its
    // padding. Observing reports every element once, so it is known before
    // the first count.
    let availableWidth = 0;

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

      setVisibleCount(
        resolveInlineOverflow({
          activeIndex,
          availableWidth,
          gap: itemGap(copies.map(({ box }) => box)),
          itemWidths: keys.map((key) => boxByKey.get(key)?.width ?? 0),
          triggerWidth: trigger?.getBoundingClientRect().width ?? 0,
        }).visibleCount,
      );
      setMeasured(true);
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === container) {
          availableWidth = entry.contentRect.width;
        }
      }
      recompute();
    });
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [activeIndex, container, measure, order]);

  return {
    /** The measured row, once mounted. */
    container,
    containerRef: setContainer,
    /** Whether the row has been measured; until then every item shows. */
    measured,
    measureRef: setMeasure,
    visibleCount: Math.min(visibleCount, itemCount),
  };
};
