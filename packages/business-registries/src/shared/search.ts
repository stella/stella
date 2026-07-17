// Every adapter's `searchByName` exposes a caller-supplied `limit` that
// gets translated into an upstream page-size parameter (Take, pocet,
// size, items_per_page, top, per_page, ...). Clamp it once here instead
// of letting each adapter hand-roll (and potentially forget) the same
// `Math.min(Math.max(...))` expression.
export const clampSearchLimit = (requested: number, max: number): number => {
  // A NaN `requested` (from a bad parse) would otherwise flow through
  // `Math.min(Math.max(NaN, 1), max)` as NaN and poison the upstream
  // page-size parameter. Treat it as the minimum. ±Infinity is fine:
  // Math.max/min already resolve it to the min/max bound.
  if (Number.isNaN(requested)) {
    return 1;
  }
  return Math.min(Math.max(requested, 1), max);
};
