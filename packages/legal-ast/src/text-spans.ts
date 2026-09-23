/**
 * Spans over a block's flattened text, shared by every locator that marks
 * something inside a legal document.
 *
 * Citations and statute provisions are located by different patterns but land
 * in the same renderer, so they resolve overlaps the same way: two locators
 * that disagreed would hand it nested marks.
 */

/** Overlapping spans keep the earlier, longer one. */
export const dropOverlappingSpans = <T extends { end: number; start: number }>(
  spans: readonly T[],
): T[] => {
  const sorted = [...spans].toSorted(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const kept: T[] = [];
  let lastEnd = -1;
  for (const span of sorted) {
    if (span.start < lastEnd) {
      continue;
    }
    kept.push(span);
    lastEnd = span.end;
  }
  return kept;
};
