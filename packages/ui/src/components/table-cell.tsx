import type * as React from "react";

import { cn } from "../lib/utils";

/**
 * Where a column sets its content. `end` lines up figures and amounts;
 * `start` is the default reading edge. A `numeric` head or cell sets to the
 * end unless it names an alignment, so a figures column needs one prop.
 */
type TableAlign = "start" | "center" | "end";

/** A muted row or cell supports its neighbours. */
type TableTone = "default" | "muted";

const TABLE_ALIGN_CLASS = {
  center: "text-center",
  end: "text-end",
  start: "text-start",
} as const satisfies Record<TableAlign, string>;

// A `prose` cell: ruled on its end and bottom, padded, set from the top at
// reading leading, and wrapped unless the table keeps cells on one line (the
// base cell already does). The first column keeps a few words per line.
const PROSE_CELL_CLASS =
  "in-data-[density=prose]:h-auto in-data-[density=prose]:border-e in-data-[density=prose]:border-b in-data-[density=prose]:px-3 in-data-[density=prose]:py-2 in-data-[density=prose]:align-top in-data-[density=prose]:leading-normal in-data-[density=prose]:last:border-e-0 in-data-[density=prose]:min-w-24 in-data-[density=prose]:first:min-w-36 in-data-[cell-text=wrap]:in-data-[density=prose]:wrap-anywhere in-data-[cell-text=wrap]:in-data-[density=prose]:whitespace-normal";

const resolveTableAlign = (
  align: TableAlign | undefined,
  numeric: boolean,
): TableAlign | undefined => align ?? (numeric ? "end" : undefined);

type TableCellFaceProps = Omit<React.ComponentProps<"td">, "align"> & {
  align?: TableAlign | undefined;
  tone?: TableTone | undefined;
  /**
   * Figures set in tabular numerals and to the end of the cell (unless
   * `align` says otherwise), so digits line up down the column.
   */
  numeric?: boolean | undefined;
  /**
   * The cell holds one control that fills it edge to edge and pads itself (a
   * button that opens the row's record), so the cell adds no padding and the
   * control's hover band reaches the cell's borders.
   */
  flush?: boolean;
};

type TableCellStyleProps = Pick<
  TableCellFaceProps,
  "align" | "className" | "flush" | "numeric" | "tone"
>;

const tableCellClassName = ({
  align,
  className,
  flush = false,
  numeric = false,
  tone = "default",
}: TableCellStyleProps) => {
  const resolvedAlign = resolveTableAlign(align, numeric);
  return cn(
    "align-middle leading-none whitespace-nowrap has-[[role=checkbox]]:pe-0",
    flush
      ? "p-0"
      : "p-2.5 in-data-[density=compact]:px-0 in-data-[density=compact]:py-1.5 in-data-[inset=card]:px-4 in-data-[slot=frame]:first:p-[calc(--spacing(2.5)-1px)] in-data-[slot=frame]:last:p-[calc(--spacing(2.5)-1px)]",
    "in-data-[density=compact]:leading-6 in-data-[density=compact]:whitespace-normal",
    PROSE_CELL_CLASS,
    "in-data-[density=prose]:[tr:last-child>&]:border-b-0",
    resolvedAlign !== undefined && TABLE_ALIGN_CLASS[resolvedAlign],
    tone === "muted" && "text-muted-foreground",
    numeric && "tabular-nums",
    className,
  );
};

const TableCellFace = ({
  align,
  className,
  flush = false,
  numeric,
  tone,
  ...props
}: TableCellFaceProps) => (
  <td
    className={tableCellClassName({ align, className, flush, numeric, tone })}
    data-slot="table-cell"
    {...props}
  />
);

export {
  PROSE_CELL_CLASS,
  TableCellFace,
  resolveTableAlign,
  tableCellClassName,
  TABLE_ALIGN_CLASS,
};
export type { TableAlign, TableCellFaceProps, TableTone };
