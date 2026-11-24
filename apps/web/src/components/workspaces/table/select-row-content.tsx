/**
 * The first cell of every row, whatever the row is: its number until the
 * pointer arrives, then the checkbox that picks it. Shift-click extends from
 * the last row picked, which is why the index and the shared latch travel in.
 */

import type React from "react";

import type { RowSelectionState } from "@tanstack/react-table";
import { row_getIsSomeSelected } from "@tanstack/react-table/static-functions";

import { Checkbox } from "@stll/ui/checkbox";
import { TABLE_FIRST_LINE as ROW_FIRST_LINE } from "@stll/ui/table";
import type { TableFirstLine as RowFirstLine } from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

import type {
  TableRow,
  TableRowData,
  TableTreeNode,
  WorkspaceTable,
} from "@/components/workspaces/table/types";

export { ROW_FIRST_LINE };
export type { RowFirstLine };

// A line box needs a glyph to have a baseline; this one has no width.
const ZERO_WIDTH_SPACE = "\u200B";

const firstLineSlot = (firstLine: RowFirstLine) =>
  cn(
    "absolute inset-x-0 top-2 flex min-w-12 items-center justify-center",
    ROW_FIRST_LINE[firstLine].slot,
  );

/**
 * An empty line of the first line's height, centred like the number. A cell
 * whose items align by baseline puts each item's first line on this one,
 * whatever padding the item carries above its text.
 */
export const FirstLineStrut = ({ firstLine }: { firstLine: RowFirstLine }) => (
  <span
    aria-hidden="true"
    className={cn(
      "flex w-0 shrink-0 items-center",
      ROW_FIRST_LINE[firstLine].slot,
    )}
    data-slot="table-first-line-strut"
  >
    {ZERO_WIDTH_SPACE}
  </span>
);

export const RowNumberLabel = ({
  className,
  firstLine,
  label,
}: {
  className?: string;
  firstLine: RowFirstLine;
  label: string;
}) => (
  <span
    className={cn(firstLineSlot(firstLine), "text-xs tabular-nums", className)}
    data-slot="table-row-number"
  >
    {label}
  </span>
);

type SelectRowContentProps<TRow extends TableRowData> = {
  ariaLabel?: string | undefined;
  firstLine: RowFirstLine;
  index: number;
  label: string;
  row: TableRow<TRow>;
  table: WorkspaceTable<TRow>;
  lastSelectedIndex: React.RefObject<number | null>;
};

export const SelectRowContent = <TRow extends TableRowData = TableTreeNode>({
  ariaLabel,
  firstLine,
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
      const patchEntries = new Map<string, true>();
      for (let i = start; i <= end; i++) {
        const r = rows[i];
        if (r) {
          patchEntries.set(r.id, true);
        }
      }
      const patch: RowSelectionState = Object.fromEntries(patchEntries);
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
    <Checkbox
      appearance="cell"
      aria-label={ariaLabel ?? label}
      checked={selected}
      indeterminate={someSelected}
      firstLine={firstLine}
      rowLabel={label}
      data-slot="table-selection-cell"
      onCheckedChange={(_checked, details) => {
        toggleSelection(
          "shiftKey" in details.event && details.event.shiftKey === true,
        );
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.stopPropagation();
        }
        if (event.key === "Enter") {
          event.preventDefault();
          toggleSelection(event.shiftKey);
        }
      }}
    />
  );
};
