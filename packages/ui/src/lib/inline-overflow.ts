/**
 * The overflow policy of a single-line row of items (tabs, chips) that
 * collapses the items that do not fit into a trailing "show more" menu.
 * The inspector facet bar and the saved-view strip both run it, so the two
 * rows decide alike which items stay on screen. Pure, so it is tested
 * without a DOM or a `ResizeObserver`; `useInlineOverflow` measures a row
 * and feeds it.
 */
export type InlineOverflowInput = {
  /** Width inside the row available to the items (the trigger's own
   * footprint is reserved out of this by the policy, not by the caller). */
  availableWidth: number;
  /** Each item's natural (measured) width, in display order. */
  itemWidths: readonly number[];
  /** Index into `itemWidths` of the active item, always kept visible
   * whenever anything is. */
  activeIndex: number;
  /** The overflow trigger's own footprint, reserved alongside the items
   * whenever not every item fits. */
  triggerWidth: number;
  /** Horizontal gap between adjacent items, and between the last item and
   * the trigger. */
  gap?: number;
};

export type InlineOverflowPolicy = {
  /** How many items are visible. Counts a prefix of `itemWidths` in their
   * given order when the active item already falls inside that prefix;
   * otherwise counts the active item plus however many others (in order,
   * skipping the active one) fit alongside it. `0` is the narrow-width
   * floor: not even the active item fits, so nothing but the trigger
   * shows. */
  visibleCount: number;
  /** Whether the overflow trigger renders at all. */
  showOverflowTrigger: boolean;
};

const sumWithGaps = (widths: readonly number[], gap: number): number =>
  widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);

/**
 * Decides the row's visible/overflow split.
 *
 * Narrow-width floor: if even the active item cannot fit beside the
 * trigger, showing it anyway would push the trigger past
 * `availableWidth`; the row clips overflow, so the trigger (the only way
 * to reach ANY item from this row) would become unreachable. Rather than
 * shrink the active item below its natural width (this policy has no
 * minimum-width input to shrink to), this drops the active item from the
 * visible row too and shows only the trigger: every item, including the
 * active one, still reaches through the overflow menu, and the trigger
 * itself always stays on screen.
 */
export const resolveInlineOverflow = ({
  availableWidth,
  itemWidths,
  activeIndex,
  triggerWidth,
  gap = 0,
}: InlineOverflowInput): InlineOverflowPolicy => {
  if (sumWithGaps(itemWidths, gap) <= availableWidth) {
    return { visibleCount: itemWidths.length, showOverflowTrigger: false };
  }

  // Overflowing: greedily keep items, in their given order, that fit
  // alongside the trigger reserved at the end.
  let used = 0;
  let count = 0;
  for (const width of itemWidths) {
    const add = width + (count > 0 ? gap : 0);
    if (used + add + gap + triggerWidth > availableWidth) {
      break;
    }
    used += add;
    count += 1;
  }

  if (activeIndex < count) {
    return { visibleCount: count, showOverflowTrigger: true };
  }

  // The active item fell outside the greedy fit above: pin it into the
  // visible set anyway (it can be wider than the item it displaces), by
  // recounting with its own width reserved first.
  const activeWidth = itemWidths[activeIndex] ?? 0;
  if (activeWidth + gap + triggerWidth > availableWidth) {
    return { visibleCount: 0, showOverflowTrigger: true };
  }

  used = activeWidth;
  count = 0;
  for (const [index, width] of itemWidths.entries()) {
    if (index === activeIndex) {
      continue;
    }
    const add = width + gap;
    if (used + add + gap + triggerWidth > availableWidth) {
      break;
    }
    used += add;
    count += 1;
  }
  return { visibleCount: count + 1, showOverflowTrigger: true };
};

export type InlineOverflowSplit<T> = {
  /** The items the row shows, in display order. */
  visible: T[];
  /** The items the overflow menu lists, in display order. */
  overflow: T[];
};

/**
 * Splits `items` the way `resolveInlineOverflow` counted them: a prefix of
 * `visibleCount` items when the active one is inside it, else the first
 * `visibleCount - 1` items and the active one after them. Every item lands
 * in exactly one of the two lists, each in its original order.
 */
export const splitInlineOverflow = <T>(
  items: readonly T[],
  visibleCount: number,
  activeIndex: number,
): InlineOverflowSplit<T> => {
  const count = Math.max(0, Math.min(visibleCount, items.length));
  if (count === items.length) {
    return { visible: [...items], overflow: [] };
  }
  if (count === 0) {
    return { visible: [], overflow: [...items] };
  }
  if (activeIndex < count) {
    return { visible: items.slice(0, count), overflow: items.slice(count) };
  }
  // The active item would overflow: it takes the last visible slot, so the
  // current item is always readable, and the rest overflow in order.
  const shown = new Set(Array.from({ length: count - 1 }, (_, index) => index));
  shown.add(activeIndex);
  return {
    visible: items.filter((_, index) => shown.has(index)),
    overflow: items.filter((_, index) => !shown.has(index)),
  };
};
