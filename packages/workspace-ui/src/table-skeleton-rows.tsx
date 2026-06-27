import type { ReactNode } from "react";

import type { Column, RowData, TableFeatures } from "@tanstack/react-table";

import { Skeleton } from "@stll/ui/components/skeleton";
import { TableCell, TableRow } from "@stll/ui/components/table";

// Stable keys so loading rows never fall back to array-index keys.
const SKELETON_ROW_KEYS = [
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

const DEFAULT_SKELETON_ROW_COUNT = 8;

type TableSkeletonRowsProps<
  TFeatures extends TableFeatures,
  TData extends RowData,
> = {
  columns: readonly Column<TFeatures, TData>[];
  rowCount?: number;
  // Per-column placeholder. Return `undefined` to use the default bar, `null`
  // for an intentionally empty cell, or any node for a custom placeholder.
  renderCell?: (column: Column<TFeatures, TData>) => ReactNode;
};

/**
 * Loading rows generated from the table's own column model, so the skeleton
 * cannot drift from the real table: add, remove, or reorder a column and the
 * placeholder gains, loses, or moves the matching cell automatically. Render it
 * inside the same `<TableBody>` the real rows use, passing the table's leaf
 * columns (e.g. `table.getAllLeafColumns()`).
 */
export const TableSkeletonRows = <
  TFeatures extends TableFeatures,
  TData extends RowData,
>({
  columns,
  rowCount = DEFAULT_SKELETON_ROW_COUNT,
  renderCell,
}: TableSkeletonRowsProps<TFeatures, TData>) => {
  const rowKeys = SKELETON_ROW_KEYS.slice(
    0,
    Math.min(rowCount, SKELETON_ROW_KEYS.length),
  );

  return rowKeys.map((rowKey) => (
    <TableRow key={rowKey}>
      {columns.map((column) => {
        const custom = renderCell?.(column);
        return (
          <TableCell key={column.id}>
            {custom === undefined ? <Skeleton className="h-4 w-3/5" /> : custom}
          </TableCell>
        );
      })}
    </TableRow>
  ));
};
