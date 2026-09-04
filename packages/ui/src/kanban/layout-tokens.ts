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
 * Where the board's chrome stacks: its header block at `z-20`, a lane's own
 * row at `z-10` under it. Both stay below the shell's chrome
 * (`SHELL_CHROME_LAYER_CLASS_NAME`), which pins a top bar around whatever the
 * board is rendered in: when the shell's content column rather than the board
 * is the scroll container, board and shell chrome are pinned in the same
 * scroller, and equal z-indexes would leave paint order to decide.
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
 * The band caption line, on the chrome row height like everything else: a band
 * names the run of columns under it, so its caption reads as their parent. A
 * shorter line with a smaller label read as a note *about* the header row, and
 * left a group looking subordinate to its own columns.
 *
 * Still named for the caption, because that row is the one a caller composes
 * against when it renders a band header of its own.
 */
export const KANBAN_BAND_CAPTION_ROW_HEIGHT = KANBAN_CHROME_ROW_HEIGHT;
export const KANBAN_BAND_CAPTION_ROW_HEIGHT_PX = KANBAN_CHROME_ROW_HEIGHT_PX;

/**
 * A finger's 44px target on a control the chrome row keeps at its own height.
 *
 * The same pseudo-element the shared `Button` extends its own targets with:
 * the visible control keeps the row's height, and only the touch surface
 * grows. The surface is a fixed 44px centred on the control rather than an
 * inset off its edges, so a 28px toggle and a 36px one both reach the same
 * distance either way, and neither spills into the row underneath: an inset
 * grows a short control downwards by whatever it is short by.
 */
export const KANBAN_CHROME_TOGGLE_COARSE_TARGET_CLASS =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:-translate-y-1/2";
