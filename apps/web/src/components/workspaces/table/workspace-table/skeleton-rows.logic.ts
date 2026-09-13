/**
 * How much of a table stands in while its rows are in flight.
 *
 * A loading table draws its own grid rather than bars beside it, so the count
 * is the page the reader is about to get — bounded, because a hundred animated
 * placeholder rows cost a hundred rows of DOM for a screen that holds a dozen.
 */

/** Stable keys so loading rows never fall back to array-index keys. Their
 * number is also the cap: no table mounts more placeholder rows than this. */
export const SKELETON_ROW_KEYS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
] as const;

/** What a table stands in when it cannot say how many rows are coming. */
const DEFAULT_SKELETON_ROW_COUNT = 5;

/**
 * One placeholder row per row the page will hold, capped at the keys above and
 * never empty: a table that draws no row at all reads as a table with none.
 */
export const tableSkeletonRowCount = (expectedRowCount?: number): number =>
  Math.max(
    1,
    Math.min(
      expectedRowCount ?? DEFAULT_SKELETON_ROW_COUNT,
      SKELETON_ROW_KEYS.length,
    ),
  );
