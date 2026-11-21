import { useEffect, useState } from "react";

import { resolveInlineOverflow } from "../lib/inline-overflow";

/** Marks one item's natural-width copy inside the measuring row. */
export const INLINE_OVERFLOW_ITEM_ATTRIBUTE = "data-inline-overflow-item";
/** Marks the overflow trigger's copy inside the measuring row. */
export const INLINE_OVERFLOW_TRIGGER_ATTRIBUTE = "data-inline-overflow-trigger";

type UseInlineOverflowOptions = {
  /** The active item's index; the policy keeps it on screen. */
  activeIndex: number;
  /** How many items the row holds. */
  itemCount: number;
};

/**
 * Measures a single-line row and decides how many of its items fit, by
 * `resolveInlineOverflow`. The caller renders two things:
 *
 * - the row (`containerRef`), whose width is the room the items and the
 *   overflow trigger share, independent of how many items it shows;
 * - an invisible, inert copy of every item at its natural width plus the
 *   trigger (`measureRef`), each marked with `INLINE_OVERFLOW_ITEM_ATTRIBUTE`
 *   or `INLINE_OVERFLOW_TRIGGER_ATTRIBUTE`, inside one flex row whose gap is
 *   the gap between items.
 *
 * Measuring the copy keeps the widths stable however many items the row is
 * currently showing, so collapsing an item never changes the measurement
 * that collapsed it. The count is recomputed when either element resizes
 * (a docked pane narrows the row, an added view or a rename widens the copy)
 * and when the active item changes.
 */
export const useInlineOverflow = ({
  activeIndex,
  itemCount,
}: UseInlineOverflowOptions) => {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [measure, setMeasure] = useState<HTMLElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(itemCount);

  useEffect(() => {
    if (!container || !measure) {
      return undefined;
    }

    const recompute = () => {
      const style = getComputedStyle(container);
      // `|| 0`: computed padding can be "" on a detached node and columnGap is
      // "normal" when no gap is set; both make parseFloat return NaN.
      const padX =
        (Number.parseFloat(style.paddingInlineStart) || 0) +
        (Number.parseFloat(style.paddingInlineEnd) || 0);
      const items = [
        ...measure.querySelectorAll(`[${INLINE_OVERFLOW_ITEM_ATTRIBUTE}]`),
      ];
      const row = items.at(0)?.parentElement;
      const gap = row
        ? Number.parseFloat(getComputedStyle(row).columnGap) || 0
        : 0;
      const trigger = measure.querySelector(
        `[${INLINE_OVERFLOW_TRIGGER_ATTRIBUTE}]`,
      );

      setVisibleCount(
        resolveInlineOverflow({
          activeIndex,
          availableWidth: container.clientWidth - padX,
          gap,
          itemWidths: items.map((item) => item.getBoundingClientRect().width),
          triggerWidth: trigger?.getBoundingClientRect().width ?? 0,
        }).visibleCount,
      );
    };

    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    observer.observe(measure);
    recompute();
    return () => observer.disconnect();
  }, [activeIndex, container, measure]);

  return {
    /** The measured row, once mounted. */
    container,
    containerRef: setContainer,
    measureRef: setMeasure,
    visibleCount: Math.min(visibleCount, itemCount),
  };
};
