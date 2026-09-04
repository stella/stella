/**
 * The heights the board's chrome rows are built from.
 *
 * A board stacks several rows of chrome above the first card — the band
 * caption, the column headers, a lane's identity and its per-column
 * summaries — and every one of them is pinned at some point, so their heights
 * are what a card's own pinned row is offset by. Naming them once keeps the
 * rows on a single rhythm and keeps the pixel value that offsets a sticky
 * control in step with the class that draws the row.
 */

/**
 * The column header row and a lane's rows: a *fixed* height, tighter than the
 * inspector's 48px toolbar row, because a board shows three of these before
 * the first card and each one costs the cards their space. Fixed rather than
 * minimum: a row that grows with its content moves every offset below it.
 */
export const KANBAN_CHROME_ROW_HEIGHT = "h-9" as const;
export const KANBAN_CHROME_ROW_HEIGHT_PX = 36 as const;

/**
 * The band caption line, one step shorter again: a band names a run of
 * columns rather than holding controls of its own, so it reads as a label
 * over the header row rather than a second row of chrome.
 */
export const KANBAN_BAND_CAPTION_ROW_HEIGHT = "h-7" as const;
export const KANBAN_BAND_CAPTION_ROW_HEIGHT_PX = 28 as const;
