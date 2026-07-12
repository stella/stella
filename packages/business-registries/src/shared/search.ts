// Every adapter's `searchByName` exposes a caller-supplied `limit` that
// gets translated into an upstream page-size parameter (Take, pocet,
// size, items_per_page, top, per_page, ...). Clamp it once here instead
// of letting each adapter hand-roll (and potentially forget) the same
// `Math.min(Math.max(...))` expression.
export const clampSearchLimit = (requested: number, max: number): number =>
  Math.min(Math.max(requested, 1), max);
