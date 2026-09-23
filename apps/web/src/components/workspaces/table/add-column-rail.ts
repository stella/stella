/**
 * The contract between the table shell and the add-column trigger it hosts in
 * the rail pinned over the table's end edge. The shell measures its header row
 * and publishes the height on the rail container; the trigger centres its "+"
 * on it. Header rows are not the same height in every table, so a fixed offset
 * would sit off-centre in all but one of them.
 */

import type { CSSProperties } from "react";

export type AddColumnRailStyle = CSSProperties & {
  "--workspace-table-header-height": string;
};

type AddColumnRailStyleInput = {
  headerHeightPx: number;
  /** The rail sits inside the vertical scrollbar, not under it. */
  scrollbarWidthPx: number;
};

export const addColumnRailStyle = ({
  headerHeightPx,
  scrollbarWidthPx,
}: AddColumnRailStyleInput): AddColumnRailStyle => ({
  "--workspace-table-header-height": `${headerHeightPx}px`,
  right: scrollbarWidthPx,
});

/**
 * A trigger hosted in the header cell itself (grouped sections) spans just
 * that cell, so the "+" centres on the trigger's own height.
 */
export const addColumnHeaderCellStyle: AddColumnRailStyle = {
  "--workspace-table-header-height": "100%",
};

/** The rail's "+", centred on the header row the shell measured. */
export const ADD_COLUMN_RAIL_PLUS_CLASS_NAME =
  "text-muted-foreground group-hover/add-column-rail:text-foreground group-focus-visible/add-column-rail:text-foreground absolute start-1/2 top-[calc(var(--workspace-table-header-height)/2)] size-4 -translate-x-1/2 -translate-y-1/2 transition-colors rtl:translate-x-1/2";
