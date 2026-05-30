/**
 * Guard against wrap margins that exceed the available content width.
 *
 * When a float's wrap margins consume the entire content width (or more),
 * there is no horizontal strip beside it for body text. Word renders the
 * following lines at full content width instead of collapsing them to a
 * 1-glyph column. Unchecked margins from near-full-width tables/images can
 * exceed contentWidth and collapse every wrap line to ~1 character.
 *
 * Returned margins are zeroed when either side alone is >= contentWidth or
 * their sum is >= contentWidth. Otherwise the original (non-negative) values
 * pass through unchanged.
 */
export function clampFloatingWrapMargins(
  leftMargin: number,
  rightMargin: number,
  contentWidth: number,
): { leftMargin: number; rightMargin: number } {
  const cw = Math.max(1, contentWidth);
  const lm = Math.max(0, leftMargin);
  const rm = Math.max(0, rightMargin);
  if (lm >= cw || rm >= cw || lm + rm >= cw) {
    return { leftMargin: 0, rightMargin: 0 };
  }
  return { leftMargin: lm, rightMargin: rm };
}
