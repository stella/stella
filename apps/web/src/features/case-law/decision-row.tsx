/**
 * One decision as a row of the workspace table.
 *
 * The grid, the pinning and the cells are the shell's; this is what a decision
 * row adds: the number-or-checkbox cell every row has, the click and the Enter
 * that open the decision beside the results, and the marker saying which row
 * the inspector is showing.
 */

import type React from "react";
import { useCallback, useRef } from "react";

import { flexRender } from "@tanstack/react-table";
import { row_getIsSelected } from "@tanstack/react-table/static-functions";

import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import type { TableRowRenderInput } from "@/components/workspaces/table/row-host";
import { SelectRowContent } from "@/components/workspaces/table/select-row-content";
import type {
  DecisionRowData,
  TableCell,
} from "@/components/workspaces/table/types";
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
import type { Decision } from "@/features/case-law/components/decision-cells";
import { isDecisionRowActive } from "@/features/case-law/decision-inspector.logic";
import { useDecisionRenderScope } from "@/features/case-law/decision-table-columns";
import { TOOLBAR_ROW_HEIGHT, TOOLBAR_ROW_MIN_HEIGHT } from "@/lib/consts";

/**
 * A gesture that already means something else: the case-number link, the
 * language menu, the question cell's source card, the row checkbox. Opening
 * the decision on top of it would take the reader somewhere they did not ask
 * to go.
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

export type DecisionRowProps = TableRowRenderInput<DecisionRowData> & {
  /** The inspector's active tab, so the open row is marked as such. */
  activeTabId: string | null;
  onOpen: (decision: Decision) => void;
};

export const DecisionRow = ({
  activeTabId,
  addPropertyColumn,
  contentMode,
  index,
  lastSelectedIndex,
  measureElement,
  onOpen,
  renderColumns,
  row,
  rowLabel,
  table,
}: DecisionRowProps) => {
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
  const decision = row.original.decision;
  const visibleCells = getOrderedCells(row.getVisibleCells(), renderColumns);
  const addPropertyCell = addPropertyColumn
    ? row
        .getVisibleCells()
        .find((cell) => cell.column.id === addPropertyColumn.id)
    : undefined;
  const isActive = isDecisionRowActive(activeTabId, decision);
  // A compact row is one fixed height, which is what makes a page of them
  // scannable; the one row a reader asked to read whole is the exception, and
  // it grows to the text rather than clipping it.
  const { expandedHeadnoteIds } = useDecisionRenderScope();
  const tightRowHeight = expandedHeadnoteIds.has(decision.id)
    ? TOOLBAR_ROW_MIN_HEIGHT
    : TOOLBAR_ROW_HEIGHT;

  const open = () => onOpen(decision);
  const handleClick = (event: React.MouseEvent) => {
    if (opensRow(event.target)) {
      open();
    }
  };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" || event.defaultPrevented) {
      return;
    }
    if (opensRow(event.target)) {
      event.preventDefault();
      open();
    }
  };

  return (
    <WorkspaceGridRow
      aria-rowindex={index + 2}
      aria-selected={row_getIsSelected(row)}
      className={cn(
        "cursor-pointer transition-opacity duration-150",
        contentMode === "tight" && tightRowHeight,
      )}
      data-active={isActive || undefined}
      data-index={index}
      data-state={row_getIsSelected(row) ? "selected" : undefined}
      onClick={containedEventHandler(handleClick)}
      onKeyDown={handleKeyDown}
      ref={setRowRef}
      tabIndex={0}
    >
      <DecisionRowCells
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

const DecisionRowCells = ({
  contentMode,
  selectCell,
  visibleCells,
}: {
  contentMode: DecisionRowProps["contentMode"];
  selectCell: React.ReactElement;
  visibleCells: TableCell<DecisionRowData>[];
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
          contentMode === "fit-content" &&
            "whitespace-normal! [&_.line-clamp-2]:line-clamp-none [&_.truncate]:min-w-0 [&_.truncate]:overflow-visible [&_.truncate]:wrap-break-word [&_.truncate]:whitespace-normal",
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
        <DecisionRowCellContent cell={cell} selectCell={selectCell} />
      </WorkspaceGridCell>
    );
  });

/**
 * The select column draws the row's own control; the add-column column is the
 * rail's spacer and draws nothing; every other column draws its cell.
 */
const DecisionRowCellContent = ({
  cell,
  selectCell,
}: {
  cell: TableCell<DecisionRowData>;
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
