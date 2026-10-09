/**
 * The first cell of every row, whatever the row is: its number until the
 * pointer arrives, then the checkbox that picks it. Shift-click extends from
 * the last row picked, which is why the index and the shared latch travel in.
 */

import type React from "react";

import type { RowSelectionState } from "@tanstack/react-table";
import { row_getIsSomeSelected } from "@tanstack/react-table/static-functions";

import { Checkbox } from "@stll/ui/checkbox";
import { cn } from "@stll/ui/utils";

import type {
  TableRow,
  TableRowData,
  TableTreeNode,
  WorkspaceTable,
} from "@/components/workspaces/table/types";

// Cells pad by p-2 and set text-sm (leading-5), so this box covers the first
// text line of every cell: the number and the checkbox stay on the line of the
// row's first value however tall the row grows, instead of floating to its middle.
const FIRST_LINE_SLOT =
  "absolute inset-x-0 top-2 flex h-5 min-w-12 items-center justify-center";

export const RowNumberLabel = ({
  className,
  label,
}: {
  className?: string;
  label: string;
}) => (
  <span
    className={cn(FIRST_LINE_SLOT, "text-xs tabular-nums", className)}
    data-slot="table-row-number"
  >
    {label}
  </span>
);

type SelectRowContentProps<TRow extends TableRowData> = {
  index: number;
  label: string;
  row: TableRow<TRow>;
  table: WorkspaceTable<TRow>;
  lastSelectedIndex: React.RefObject<number | null>;
};

export const SelectRowContent = <TRow extends TableRowData = TableTreeNode>({
  index,
  label,
  row,
  table,
  lastSelectedIndex,
}: SelectRowContentProps<TRow>) => {
  // A row that contains others is partly selected when only some of them are;
  // a kind whose rows never nest has no sub-rows and so never shows it.
  const selected = table.state.rowSelection[row.id] === true;
  const someSelected = row.subRows.length > 0 && row_getIsSomeSelected(row);

  const toggleSelection = (shiftKey: boolean) => {
    if (shiftKey && lastSelectedIndex.current !== null) {
      const start = Math.min(lastSelectedIndex.current, index);
      const end = Math.max(lastSelectedIndex.current, index);
      const rows = table.getRowModel().rows;
      const patch: RowSelectionState = {};
      for (let i = start; i <= end; i++) {
        const r = rows[i];
        if (r) {
          patch[r.id] = true;
        }
      }
      table.setRowSelection((prev) => ({
        ...prev,
        ...patch,
      }));
    } else {
      row.toggleSelected();
    }
    // oxlint-disable-next-line react/immutability -- lastSelectedIndex is a RefObject prop; writing `.current` is the intended ref write (shared with the parent), not a prop mutation
    lastSelectedIndex.current = index;
  };

  return (
    <button
      aria-checked={someSelected ? "mixed" : selected}
      aria-label={label}
      className="group/selection ring-ring hover:bg-muted/50 absolute inset-0 min-w-12 shrink-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset"
      data-slot="table-selection-cell"
      onClick={(event) => {
        event.stopPropagation();
        toggleSelection(event.shiftKey);
      }}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.stopPropagation();
        }
      }}
      role="checkbox"
      type="button"
    >
      <RowNumberLabel
        className="transition-opacity group-hover/row:opacity-0 group-focus-visible/selection:opacity-0 group-data-[state=selected]/row:opacity-0"
        label={label}
      />
      <span
        className={cn(
          FIRST_LINE_SLOT,
          "pointer-events-none opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/selection:opacity-100 group-data-[state=selected]/row:opacity-100",
        )}
      >
        <Checkbox
          aria-hidden="true"
          checked={selected}
          className="shrink-0"
          indeterminate={someSelected}
          readOnly
          render={<span />}
          tabIndex={-1}
        />
      </span>
    </button>
  );
};
