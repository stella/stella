/**
 * What the table shell needs from whoever owns its rows.
 *
 * The shell draws a grid: columns, their order, their pinning, the virtualized
 * window, the drag-and-drop of headers. Everything that depends on what a row
 * *is* — how it draws, what a collapsed one stands for, what survives a select
 * all, the controls beside and below the grid — comes in through this host,
 * typed by the row kind it serves. A host for one kind therefore cannot be
 * handed a row of another, and a kind that has no such behaviour omits it
 * rather than supplying a stub the shell would have to ignore.
 */

import type { ReactNode, RefObject } from "react";

import type {
  TableColumn,
  TableRow,
  TableRowData,
  TableTreeNode,
  WorkspaceTable,
} from "@/components/workspaces/table/types";
import type { TableContentMode } from "@/lib/workspaces/table-store";

/** What the shell knows about a row it is asking the host to draw. */
export type TableRowRenderInput<TRow extends TableRowData = TableTreeNode> = {
  row: TableRow<TRow>;
  /** Position in the rendered window, for the row label and shift-select. */
  index: number;
  /** The row's number, or the range a collapsed row stands for. */
  rowLabel: string;
  renderColumns: TableColumn<TRow>[];
  addPropertyColumn: TableColumn<TRow> | null;
  table: WorkspaceTable<TRow>;
  contentMode: TableContentMode;
  /** The column expanded on this row, when one is. */
  expandedCellId: string | null;
  /** Whether any row has an expanded cell, so the rest recede. */
  hasExpandedTableCell: boolean;
  lastSelectedIndex: RefObject<number | null>;
  measureElement: (element: Element | null) => void;
  onToggleExpandedCell: (
    rowId: string,
    columnId: string,
    mode?: "toggle" | "open",
  ) => void;
};

export type TableRowHost<TRow extends TableRowData = TableTreeNode> = {
  /** Draws one row of this host's kind. */
  renderRow: (input: TableRowRenderInput<TRow>) => ReactNode;
  /**
   * How many further rows a collapsed row stands for, so its label can show a
   * range. Omitted by a kind whose rows never contain others.
   */
  collapsedRowSpan?: (row: TRow) => number;
  /**
   * Row ids that may stay selected when "select all" is toggled, read at click
   * time. Omitted when the host's selectable rows already cover every row.
   */
  preservableRowIds?: () => readonly string[] | undefined;
  /** The rail beside the add-column column; omitted when the host adds none. */
  addColumnRail?: ReactNode;
  /** The row under the last one; omitted when the host cannot add rows. */
  bottomRow?: ReactNode;
};
