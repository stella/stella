/**
 * Layout constants the inspector chrome is built from.
 *
 * The rail's cells, the header strip, and the property rows all share one
 * height, so a pane assembled from these parts keeps a single vertical
 * rhythm no matter which of them a section happens to use.
 */

/**
 * Every inspector row, header strip, and rail cell is exactly this tall.
 * A *fixed* height, not a minimum: rows that grow with their content break
 * the vertical rhythm the rail's 48px cells establish, and a list of
 * key/value rows stops scanning as a list once the rows differ in height.
 */
export const TOOLBAR_ROW_HEIGHT = "h-12" as const;
export const TOOLBAR_ROW_HEIGHT_PX = 48 as const;

export const SIDE_RAIL_WIDTH = "w-12" as const;
/**
 * Borders sit on both inline edges of the rail box so the total footprint
 * stays exactly 48px under `border-box`.
 */
export const SIDE_RAIL_CONTAINER_CLASS =
  `bg-sidebar flex shrink-0 flex-col border-s border-e ${SIDE_RAIL_WIDTH}` as const;
export const SIDE_RAIL_ICON_BUTTON_SIZE = "size-8" as const;
export const SIDE_RAIL_TAB_ICON_SIZE = "size-3.5" as const;

/** Two-column grid the key/value rows share. */
export const PROPERTY_ROW_GRID = "grid-cols-[8rem_minmax(0,1fr)]" as const;
