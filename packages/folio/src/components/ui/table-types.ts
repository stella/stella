/**
 * Table types and utilities used by DocxEditor's table command handler.
 * Extracted from the original TableToolbar — types + pure functions only.
 */

import type { Table, TableCell, TableRow } from "../../core/types/document";

export type TableAction =
  | "addRowAbove"
  | "addRowBelow"
  | "addColumnLeft"
  | "addColumnRight"
  | "deleteRow"
  | "deleteColumn"
  | "mergeCells"
  | "splitCell"
  | "deleteTable"
  | "selectTable"
  | "selectRow"
  | "selectColumn"
  | "borderAll"
  | "borderOutside"
  | "borderInside"
  | "borderNone"
  | "borderTop"
  | "borderBottom"
  | "borderLeft"
  | "borderRight"
  | { type: "cellFillColor"; color: string | null }
  | { type: "borderColor"; color: string }
  | { type: "borderWidth"; size: number }
  | {
      type: "cellBorder";
      side: "top" | "bottom" | "left" | "right" | "all";
      style: string;
      size: number;
      color: string;
    }
  | { type: "cellVerticalAlign"; align: "top" | "center" | "bottom" }
  | {
      type: "cellMargins";
      margins: {
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
      };
    }
  | { type: "cellTextDirection"; direction: string | null }
  | { type: "toggleNoWrap" }
  | {
      type: "rowHeight";
      height: number | null;
      rule?: "auto" | "atLeast" | "exact";
    }
  | { type: "toggleHeaderRow" }
  | { type: "distributeColumns" }
  | { type: "autoFitContents" }
  | {
      type: "tableProperties";
      props: {
        width?: number | null;
        widthType?: string | null;
        justification?: "left" | "center" | "right" | null;
      };
    }
  | { type: "openTableProperties" }
  | { type: "applyTableStyle"; styleId: string };

export type TableSelection = {
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
  selectedCells?: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  };
};

export type TableContext = {
  table: Table;
  selection: TableSelection;
  hasMultiCellSelection: boolean;
  canSplitCell: boolean;
  rowCount: number;
  columnCount: number;
};

// ---------------------------------------------------------------------------
// Table manipulation utilities
// ---------------------------------------------------------------------------

export const getColumnCount = (table: Table): number => {
  let maxCols = 0;
  for (const row of table.rows) {
    let colCount = 0;
    for (const cell of row.cells) {
      colCount += cell.formatting?.gridSpan ?? 1;
    }
    maxCols = Math.max(maxCols, colCount);
  }
  return maxCols;
};

export const getCellAt = (
  table: Table,
  rowIndex: number,
  columnIndex: number,
): TableCell | null => {
  const row = table.rows[rowIndex];
  if (!row) {
    return null;
  }
  let currentCol = 0;
  for (const cell of row.cells) {
    const colspan = cell.formatting?.gridSpan ?? 1;
    if (columnIndex >= currentCol && columnIndex < currentCol + colspan) {
      return cell;
    }
    currentCol += colspan;
  }
  return null;
};

export const createTableContext = (
  table: Table,
  selection: TableSelection,
): TableContext => {
  const rowCount = table.rows.length;
  const columnCount = getColumnCount(table);
  const hasMultiCellSelection = !!(
    selection.selectedCells &&
    (selection.selectedCells.startRow !== selection.selectedCells.endRow ||
      selection.selectedCells.startCol !== selection.selectedCells.endCol)
  );
  const currentCell = getCellAt(
    table,
    selection.rowIndex,
    selection.columnIndex,
  );
  const canSplitCell = !!(
    currentCell &&
    ((currentCell.formatting?.gridSpan ?? 1) > 1 ||
      currentCell.formatting?.vMerge === "restart")
  );
  return {
    table,
    selection,
    hasMultiCellSelection,
    canSplitCell,
    rowCount,
    columnCount,
  };
};

const createEmptyCell = (): TableCell => ({
  type: "tableCell",
  content: [{ type: "paragraph" as const, content: [], formatting: {} }],
  formatting: {},
});

const createEmptyRow = (
  templateRow: TableRow,
  columnCount: number,
): TableRow => {
  const cells: TableCell[] = [];
  let colIndex = 0;
  for (const templateCell of templateRow.cells) {
    cells.push({
      type: "tableCell",
      content: [{ type: "paragraph" as const, content: [], formatting: {} }],
      formatting: (() => {
        if (!templateCell.formatting) return {};
        const { vMerge: _vm, ...rest } = templateCell.formatting;
        return rest;
      })(),
    });
    colIndex += templateCell.formatting?.gridSpan ?? 1;
  }
  while (colIndex < columnCount) {
    cells.push(createEmptyCell());
    colIndex++;
  }
  return {
    type: "tableRow",
    cells,
    formatting: { ...templateRow.formatting, header: false },
  };
};

export const addRow = (
  table: Table,
  atIndex: number,
  position: "before" | "after" = "after",
): Table => {
  const newRows = [...table.rows];
  const insertIndex = position === "before" ? atIndex : atIndex + 1;
  const templateRow = table.rows[atIndex] ?? table.rows[0];
  if (!templateRow) {
    return table;
  }
  newRows.splice(
    insertIndex,
    0,
    createEmptyRow(templateRow, getColumnCount(table)),
  );
  return { ...table, rows: newRows };
};

export const deleteRow = (table: Table, rowIndex: number): Table => {
  if (table.rows.length <= 1) {
    return table;
  }
  return { ...table, rows: table.rows.filter((_, i) => i !== rowIndex) };
};

export const addColumn = (
  table: Table,
  atIndex: number,
  position: "before" | "after" = "after",
): Table => {
  const insertIndex = position === "before" ? atIndex : atIndex + 1;
  const newRows = table.rows.map((row) => {
    const newCells = [...row.cells];
    let currentCol = 0;
    let insertCellIndex = 0;
    for (let i = 0; i < row.cells.length; i++) {
      const colspan = row.cells[i]?.formatting?.gridSpan ?? 1;
      if (insertIndex <= currentCol + colspan) {
        insertCellIndex = position === "before" ? i : i + 1;
        break;
      }
      currentCol += colspan;
      insertCellIndex = i + 1;
    }
    newCells.splice(insertCellIndex, 0, createEmptyCell());
    return { ...row, cells: newCells };
  });
  let newColumnWidths = table.columnWidths;
  if (table.columnWidths && table.columnWidths.length > 0) {
    newColumnWidths = [...table.columnWidths];
    const templateWidth =
      table.columnWidths[atIndex] ?? table.columnWidths[0] ?? 1440;
    newColumnWidths.splice(insertIndex, 0, templateWidth);
  }
  return {
    ...table,
    rows: newRows,
    ...(newColumnWidths !== undefined ? { columnWidths: newColumnWidths } : {}),
  };
};

export const deleteColumn = (table: Table, columnIndex: number): Table => {
  if (getColumnCount(table) <= 1) {
    return table;
  }
  const newRows = table.rows.map((row) => {
    let currentCol = 0;
    const newCells: TableCell[] = [];
    for (const cell of row.cells) {
      const colspan = cell.formatting?.gridSpan ?? 1;
      if (columnIndex >= currentCol && columnIndex < currentCol + colspan) {
        if (colspan > 1) {
          newCells.push({
            ...cell,
            formatting: { ...cell.formatting, gridSpan: colspan - 1 },
          });
        }
      } else {
        newCells.push(cell);
      }
      currentCol += colspan;
    }
    return { ...row, cells: newCells };
  });
  let newColumnWidths = table.columnWidths;
  if (table.columnWidths && table.columnWidths.length > columnIndex) {
    newColumnWidths = table.columnWidths.filter((_, i) => i !== columnIndex);
  }
  return {
    ...table,
    rows: newRows,
    ...(newColumnWidths !== undefined ? { columnWidths: newColumnWidths } : {}),
  };
};

export const mergeCells = (table: Table, selection: TableSelection): Table => {
  if (!selection.selectedCells) {
    return table;
  }
  const { startRow, startCol, endRow, endCol } = selection.selectedCells;
  const rowSpan = endRow - startRow + 1;
  const colSpan = endCol - startCol + 1;
  const newRows = table.rows.map((row, rowIndex) => {
    if (rowIndex < startRow || rowIndex > endRow) {
      return row;
    }
    const newCells: TableCell[] = [];
    let currentCol = 0;
    for (const cell of row.cells) {
      const cellColSpan = cell.formatting?.gridSpan ?? 1;
      const cellEndCol = currentCol + cellColSpan - 1;
      const inSelection = currentCol <= endCol && cellEndCol >= startCol;
      if (!inSelection) {
        newCells.push(cell);
      } else if (rowIndex === startRow && currentCol === startCol) {
        newCells.push({
          ...cell,
          formatting: {
            ...cell.formatting,
            gridSpan: colSpan,
            ...(rowSpan > 1 ? { vMerge: "restart" as const } : {}),
          },
        });
      } else if (rowIndex > startRow && currentCol === startCol) {
        newCells.push({
          ...cell,
          formatting: {
            ...cell.formatting,
            gridSpan: colSpan,
            vMerge: "continue" as const,
          },
        });
      }
      currentCol += cellColSpan;
    }
    return { ...row, cells: newCells };
  });
  return { ...table, rows: newRows };
};

export const splitCell = (
  table: Table,
  rowIndex: number,
  columnIndex: number,
): Table => {
  const cell = getCellAt(table, rowIndex, columnIndex);
  if (!cell) {
    return table;
  }
  const gridSpan = cell.formatting?.gridSpan ?? 1;
  const isVMergeStart = cell.formatting?.vMerge === "restart";
  if (gridSpan <= 1 && !isVMergeStart) {
    return table;
  }
  const newRows = table.rows.map((row, rIndex) => {
    if (rIndex !== rowIndex && !isVMergeStart) {
      return row;
    }
    const newCells: TableCell[] = [];
    let currentCol = 0;
    for (const rowCell of row.cells) {
      const cellColSpan = rowCell.formatting?.gridSpan ?? 1;
      if (
        currentCol === columnIndex ||
        (currentCol <= columnIndex && columnIndex < currentCol + cellColSpan)
      ) {
        if (gridSpan > 1) {
          for (let i = 0; i < gridSpan; i++) {
            newCells.push({
              type: "tableCell",
              content:
                i === 0
                  ? rowCell.content
                  : [
                      {
                        type: "paragraph" as const,
                        content: [],
                        formatting: {},
                      },
                    ],
              formatting: (() => {
                if (!rowCell.formatting) return {};
                const { gridSpan: _gs, vMerge: _vm, ...rest } = rowCell.formatting;
                return rest;
              })(),
            });
          }
        } else if (isVMergeStart && rIndex === rowIndex) {
          newCells.push({
            ...rowCell,
            formatting: (() => {
              if (!rowCell.formatting) return {};
              const { vMerge: _vm, ...rest } = rowCell.formatting;
              return rest;
            })(),
          });
        } else if (rowCell.formatting?.vMerge === "continue") {
          newCells.push({
            type: "tableCell",
            content: [
              { type: "paragraph" as const, content: [], formatting: {} },
            ],
            formatting: (() => {
              if (!rowCell.formatting) return {};
              const { vMerge: _vm, ...rest } = rowCell.formatting;
              return rest;
            })(),
          });
        } else {
          newCells.push(rowCell);
        }
      } else {
        newCells.push(rowCell);
      }
      currentCol += cellColSpan;
    }
    return { ...row, cells: newCells };
  });
  return { ...table, rows: newRows };
};
