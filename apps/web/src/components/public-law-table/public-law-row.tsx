/**
 * One result as a row of the workspace table, whatever the result is.
 *
 * The grid, the pinning and the cells are the shell's; this is what a
 * public-law results row adds: the number-or-checkbox cell every row has, the
 * click and the Enter that open the result, and the marker saying which row
 * the inspector is showing. What opening means, and which row is showing, is
 * the row host's.
 */

import type React from "react";
import { useCallback, useRef } from "react";

import { flexRender } from "@tanstack/react-table";
import { row_getIsSelected } from "@tanstack/react-table/static-functions";

import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import type { PublicLawRowData } from "@/components/public-law-table/public-law-table";
import type { TableRowRenderInput } from "@/components/workspaces/table/row-host";
import { SelectRowContent } from "@/components/workspaces/table/select-row-content";
import type { TableCell } from "@/components/workspaces/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import { getOrderedCells } from "@/components/workspaces/table/workspace-grid-order";
import {
  AddPropertyCell,
  RowEndFillerCell,
} from "@/components/workspaces/table/workspace-table/end-fillers";
import { PinnedBoundary } from "@/components/workspaces/table/workspace-table/internals";
import {
  addPropertyColId,
  getGridPinningStyles,
  isPinnedBoundaryColumn,
  selectColId,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { TOOLBAR_ROW_MIN_HEIGHT } from "@/lib/consts";

/**
 * A gesture that already means something else: a link in a cell, a menu, a
 * source card, the row checkbox. Opening the row on top of it would take the
 * reader somewhere they did not ask to go.
 */
const opensRow = (target: EventTarget): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.closest(
      "a, button, input, textarea, select, [role='button'], [role='checkbox'], [data-row-expansion-ignore], [data-slot='select-trigger']",
    ) === null
  );
};

export type PublicLawRowProps<TRow extends PublicLawRowData> =
  TableRowRenderInput<TRow> & {
    /** Whether the inspector is showing this row's result. */
    isActive: boolean;
    onOpen: () => void;
    /**
     * Anything that changes the row's height from inside a cell (a headnote
     * shown whole). The virtualizer only learns a row's height from the row,
     * so a change it is not told about is drawn as empty space under the rows.
     */
    remeasureKey?: unknown;
  };

export const PublicLawRow = <TRow extends PublicLawRowData>({
  addPropertyColumn,
  contentMode,
  index,
  isActive,
  lastSelectedIndex,
  measureElement,
  onOpen,
  remeasureKey,
  renderColumns,
  row,
  rowLabel,
  table,
}: PublicLawRowProps<TRow>) => {
  const rowRef = useRef<HTMLDivElement>(null);
  // Stable ref callback so React doesn't re-run TanStack Virtual's
  // measureElement on every render.
  const setRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      rowRef.current = element;
      measureElement(element);
    },
    [measureElement],
  );
  const visibleCells = getOrderedCells(row.getVisibleCells(), renderColumns);
  const addPropertyCell = addPropertyColumn
    ? row
        .getVisibleCells()
        .find((cell) => cell.column.id === addPropertyColumn.id)
    : undefined;
  useExternalSyncEffect(() => {
    if (rowRef.current) {
      measureElement(rowRef.current);
    }
  }, [contentMode, measureElement, remeasureKey]);

  const handleClick = (event: React.MouseEvent) => {
    if (opensRow(event.target)) {
      onOpen();
    }
  };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" || event.defaultPrevented) {
      return;
    }
    if (opensRow(event.target)) {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <WorkspaceGridRow
      aria-rowindex={index + 2}
      aria-selected={row_getIsSelected(row)}
      className={cn(
        "cursor-pointer transition-opacity duration-150",
        // The compact height is a floor, not a ceiling. The density clamps
        // prose to two lines, and a fixed height that cannot hold the two
        // lines it promised clips them. A row whose content fits keeps the
        // rhythm; one that does not, grows.
        contentMode === "tight" && TOOLBAR_ROW_MIN_HEIGHT,
      )}
      data-active={isActive || undefined}
      data-index={index}
      data-state={row_getIsSelected(row) ? "selected" : undefined}
      onClick={containedEventHandler(handleClick)}
      onKeyDown={handleKeyDown}
      ref={setRowRef}
      tabIndex={0}
    >
      <PublicLawRowCells
        contentMode={contentMode}
        selectCell={
          <SelectRowContent
            index={index}
            label={rowLabel}
            lastSelectedIndex={lastSelectedIndex}
            row={row}
            table={table}
          />
        }
        visibleCells={visibleCells}
      />
      <RowEndFillerCell
        addPropertyColumn={addPropertyColumn}
        renderColumns={renderColumns}
        selected={row_getIsSelected(row)}
      />
      <AddPropertyCell
        cell={addPropertyCell}
        columnIndex={renderColumns.length + 1}
        selected={row_getIsSelected(row)}
      />
    </WorkspaceGridRow>
  );
};

const PublicLawRowCells = <TRow extends PublicLawRowData>({
  contentMode,
  selectCell,
  visibleCells,
}: {
  contentMode: TableRowRenderInput<TRow>["contentMode"];
  selectCell: React.ReactElement;
  visibleCells: TableCell<TRow>[];
}) =>
  visibleCells.map((cell, cellIndex) => {
    const isSelectCell = cell.column.id === selectColId;

    return (
      <WorkspaceGridCell
        aria-colindex={cellIndex + 1}
        className={cn(
          "relative",
          isSelectCell && "min-w-12 shrink-0",
          isPinnedBoundaryColumn(cell.column) && "border-e-0",
          cell.column.columnDef.meta?.muted && "text-muted-foreground",
          // Prose unfolds; a line marked one-line (the identity under the
          // case number) keeps its truncation, or a long court name would
          // stack six lines and set the height of the row.
          contentMode === "fit-content" &&
            "whitespace-normal! [&_.line-clamp-2]:line-clamp-none [&_.truncate:not([data-one-line]_*)]:min-w-0 [&_.truncate:not([data-one-line]_*)]:overflow-visible [&_.truncate:not([data-one-line]_*)]:wrap-break-word [&_.truncate:not([data-one-line]_*)]:whitespace-normal",
          cell.column.getIsResizing() &&
            "after:bg-info after:pointer-events-none after:absolute after:end-0 after:top-0 after:bottom-0 after:z-50 after:w-px",
        )}
        data-state={row_getIsSelected(cell.row) ? "selected" : undefined}
        key={cell.id}
        style={{
          gridColumn: cellIndex + 1,
          ...getGridPinningStyles(cell.column),
        }}
      >
        <PinnedBoundary column={cell.column} />
        <PublicLawRowCellContent cell={cell} selectCell={selectCell} />
      </WorkspaceGridCell>
    );
  });

/**
 * The select column draws the row's own control; the add-column column is the
 * rail's spacer and draws nothing; every other column draws its cell.
 */
const PublicLawRowCellContent = <TRow extends PublicLawRowData>({
  cell,
  selectCell,
}: {
  cell: TableCell<TRow>;
  selectCell: React.ReactElement;
}): React.ReactElement | null => {
  if (cell.column.id === selectColId) {
    return selectCell;
  }
  if (cell.column.id === addPropertyColId) {
    return null;
  }
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5">
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </span>
  );
};
