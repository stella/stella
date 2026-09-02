/**
 * Pure overflow policy for `InspectorFacetBar`: given the row's available
 * width and each chip's natural (measured) width, decides how many chips
 * stay visible and whether the overflow trigger renders — kept out of the
 * component so it's unit-testable without a DOM or a `ResizeObserver`.
 */
export type FacetOverflowInput = {
  /** Width inside the row available to the chips (the trigger's own
   * footprint is reserved out of this by the policy, not by the caller). */
  availableWidth: number;
  /** Each chip's natural width, in the same order as the facets they
   * represent. */
  chipWidths: readonly number[];
  /** Index into `chipWidths` of the active chip — always kept visible
   * whenever anything is. */
  activeIndex: number;
  /** The overflow trigger's own footprint, reserved alongside the chips
   * whenever not every chip fits. */
  triggerWidth: number;
  /** Horizontal gap between adjacent chips, and between the last chip and
   * the trigger. */
  gap?: number;
};

export type FacetOverflowPolicy = {
  /** How many chips are visible. Counts a prefix of `chipWidths` in their
   * given order when the active chip already falls inside that prefix;
   * otherwise counts the active chip plus however many others (in order,
   * skipping the active one) fit alongside it. `0` is the narrow-width
   * floor: not even the active chip fits, so nothing but the trigger
   * shows. */
  visibleCount: number;
  /** Whether the overflow trigger renders at all. */
  showOverflowTrigger: boolean;
};

const sumWithGaps = (widths: readonly number[], gap: number): number =>
  widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);

/**
 * Decides the facet row's visible/overflow split.
 *
 * Narrow-width floor: if even the active chip cannot fit beside the
 * trigger, showing it anyway would push the trigger past
 * `availableWidth` — the row clips overflow, so the trigger (the only way
 * to reach ANY facet from this row) would become unreachable. Rather than
 * shrink the active chip below its natural width (this policy has no
 * minimum-width input to shrink to), this drops the active chip from the
 * visible row too and shows only the trigger: every facet, including the
 * active one, still reaches through the overflow menu, and the trigger
 * itself always stays on screen.
 */
export const resolveFacetOverflow = ({
  availableWidth,
  chipWidths,
  activeIndex,
  triggerWidth,
  gap = 0,
}: FacetOverflowInput): FacetOverflowPolicy => {
  if (sumWithGaps(chipWidths, gap) <= availableWidth) {
    return { visibleCount: chipWidths.length, showOverflowTrigger: false };
  }

  // Overflowing: greedily keep chips, in their given order, that fit
  // alongside the trigger reserved at the end.
  let used = 0;
  let count = 0;
  for (const width of chipWidths) {
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

  // The active chip fell outside the greedy fit above: pin it into the
  // visible set anyway (it can be wider than the chip it displaces), by
  // recounting with its own width reserved first.
  const activeWidth = chipWidths[activeIndex] ?? 0;
  if (activeWidth + gap + triggerWidth > availableWidth) {
    return { visibleCount: 0, showOverflowTrigger: true };
  }

  used = activeWidth;
  count = 0;
  for (const [index, width] of chipWidths.entries()) {
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
