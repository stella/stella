/**
 * Author Color Assignment for Tracked Changes
 *
 * Word-style per-author colors. The first unique author seen gets red (#c00000),
 * the second gets blue, etc. Assignment is deterministic within a document
 * session: the same author always receives the same color.
 */

/** Word-style tracked change author colors (5-color rotation) */
export const AUTHOR_COLORS = [
  "#c00000", // red
  "#2f5496", // blue
  "#538135", // green
  "#7030a0", // purple
  "#bf8f00", // gold
] as const;

const authorColorMap = new Map<string, number>();

/** Returns a stable color index (0..4) for a given author name */
export const getAuthorColorIdx = (author: string): number => {
  if (!authorColorMap.has(author)) {
    authorColorMap.set(author, authorColorMap.size % AUTHOR_COLORS.length);
  }
  // The key is guaranteed to exist by the `has` + `set` above
  const idx = authorColorMap.get(author);
  if (idx === undefined) {
    return 0;
  }
  return idx;
};

/** Reset the author-to-color mapping (e.g., when loading a new document) */
export const resetAuthorColors = (): void => {
  authorColorMap.clear();
};
