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

/**
 * The first line of a host's cells. Every cell pads by p-2; the host's cell
 * content reserves `content` as its minimum height and puts its first line in
 * the middle of it, and the number and checkbox take `slot`, the same line. Both come from the one
 * key a host passes, so the number stays on its row's first line however tall
 * the row grows, instead of floating to its middle or above the text.
 */
export const ROW_FIRST_LINE = {
  /** Plain text lines: text-sm, leading-5. */
  text: { slot: "h-5", content: "min-h-5" },
  /** Editable values: a text-sm line inside a py-1 control. */
  control: { slot: "h-7", content: "min-h-7" },
} as const satisfies Record<string, { slot: string; content: string }>;

export type RowFirstLine = keyof typeof ROW_FIRST_LINE;

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
  firstLine: RowFirstLine;
  index: number;
  label: string;
  row: TableRow<TRow>;
  table: WorkspaceTable<TRow>;
  lastSelectedIndex: React.RefObject<number | null>;
};

export const SelectRowContent = <TRow extends TableRowData = TableTreeNode>({
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
        firstLine={firstLine}
        label={label}
      />
      <span
        className={cn(
          firstLineSlot(firstLine),
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
