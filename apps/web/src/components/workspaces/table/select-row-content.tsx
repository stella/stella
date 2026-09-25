/**
 * The first cell of every row, whatever the row is: its number until the
 * pointer arrives, then the checkbox that picks it. Shift-click extends from
 * the last row picked, which is why the index and the shared latch travel in.
 */

import type React from "react";

import type { RowSelectionState } from "@tanstack/react-table";
import {
  row_getIsSelected,
  row_getIsSomeSelected,
} from "@tanstack/react-table/static-functions";

import { Checkbox } from "@stll/ui/checkbox";

import type {
  TableRow,
  TableRowData,
  TableTreeNode,
  WorkspaceTable,
} from "@/components/workspaces/table/types";

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
  const someSelected = row.subRows.length > 0 && row_getIsSomeSelected(row);

  const handleChange = (_checked: boolean, eventDetails: { event: Event }) => {
    if (
      eventDetails.event instanceof PointerEvent &&
      eventDetails.event.shiftKey &&
      lastSelectedIndex.current !== null
    ) {
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
    <div className="absolute inset-0 flex min-w-12 shrink-0 items-center justify-center">
      <span className="absolute inset-0 flex min-w-12 shrink-0 items-center justify-center text-xs tabular-nums transition-opacity group-hover/row:opacity-0 group-data-[state=selected]/row:opacity-0">
        {label}
      </span>
      <Checkbox
        checked={row_getIsSelected(row)}
        className="pointer-events-none absolute shrink-0 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-data-[state=selected]/row:pointer-events-auto group-data-[state=selected]/row:opacity-100"
        indeterminate={someSelected}
        onCheckedChange={handleChange}
        tabIndex={row_getIsSelected(row) ? 0 : -1}
      />
    </div>
  );
};
