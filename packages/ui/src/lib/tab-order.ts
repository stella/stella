/**
 * Whether a committed tab list holds different elements, or the same elements
 * in a different order, than the previous commit.
 *
 * Base UI measures the tabs indicator during render, from the DOM as it stood
 * *before* the commit. Its own correction is a `ResizeObserver` over the tab
 * elements, which cannot see a tab that moved without changing size. So a
 * commit that reorders, inserts, or removes a tab leaves the indicator on the
 * active tab's old coordinates until something else forces a re-render.
 *
 * Detecting that case is the whole of the workaround: compare element identity
 * rather than count or content, because React moves the same DOM nodes when it
 * reorders keyed children, and a pure move is exactly what the
 * `ResizeObserver` misses. Identity is all this needs, so it stays generic
 * rather than reaching for the DOM.
 */
export const hasTabOrderChanged = <T>(
  previous: readonly T[],
  next: readonly T[],
): boolean =>
  previous.length !== next.length ||
  next.some((tab, index) => tab !== previous[index]);
