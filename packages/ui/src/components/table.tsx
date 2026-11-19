import type * as React from "react";

import { cn } from "../lib/utils";
import { Button } from "./button";
import {
  ariaSortOf,
  HEAD_CONTENT_CLASS,
  resolveTableAlign,
  SORT_ICON_SLOT_CLASS,
  sortableHeadButtonClassName,
  SortDirectionIcon,
  Table,
  TableBody,
  tableCellClassName,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table-shell";
import type {
  SortDirection,
  TableAlign,
  TableDensity,
  TableHeaderProps,
  TableHeadProps,
  TableInset,
  TableProps,
  TableScroll,
  TableTone,
} from "./table-shell";
import { TruncatedText } from "./truncated-text";

type TableCellProps = Omit<React.ComponentProps<"td">, "align"> & {
  align?: TableAlign | undefined;
  tone?: TableTone | undefined;
  /**
   * Figures set in tabular numerals and to the end of the cell (unless
   * `align` says otherwise), so digits line up down the column.
   */
  numeric?: boolean | undefined;
  /**
   * Cuts text that overflows the cell with an ellipsis; the caller bounds the
   * cell's width (`max-w-xs`).
   */
  truncate?: boolean;
  /**
   * The cell holds one control that fills it edge to edge and pads itself (a
   * button that opens the row's record), so the cell adds no padding and the
   * control's hover band reaches the cell's borders.
   */
  flush?: boolean;
};

const TableCell = ({
  className,
  align,
  tone = "default",
  numeric = false,
  truncate = false,
  flush = false,
  children,
  ...props
}: TableCellProps) => {
  const cellClassName = tableCellClassName({
    align,
    className,
    flush,
    numeric,
    tone,
  });
  if (truncate) {
    // The cell itself is cut, so it stays a table cell rather than the
    // block TruncatedText makes of a single line.
    return (
      <TruncatedText
        className={cn("table-cell", cellClassName)}
        data-slot="table-cell"
        render={<td {...props} />}
      >
        {children}
      </TruncatedText>
    );
  }
  return (
    <td className={cellClassName} data-slot="table-cell" {...props}>
      {children}
    </td>
  );
};

type SortableHeadProps = Omit<TableHeadProps, "onClick"> & {
  sortDirection?: SortDirection;
  onSort: () => void;
  /** Rendered next to the sort button inside the same cell (e.g. filter icon). */
  trailing?: React.ReactNode;
};

/**
 * A column head the reader sorts by. The label is a quiet `Button`, so it
 * has the design system's hover band, focus ring and touch target; its
 * padding is pulled back so the label still lines up with the cells below
 * (`sortableHeadButtonClassName`). `SortableHeadFace` (./table-shell.tsx) is
 * the same head without behaviour, for a loading view.
 */
const SortableHead = ({
  children,
  sortDirection = null,
  onSort,
  trailing,
  className,
  align,
  numeric = false,
  ...props
}: SortableHeadProps) => (
  <TableHead
    align={align}
    aria-sort={ariaSortOf(sortDirection)}
    className={className}
    numeric={numeric}
    {...props}
    // After the spread on purpose: the props type omits `onClick` because the
    // sort button below owns activation, but omitting it only rejects a
    // literal attribute. A props object typed wider stays assignable and
    // carries the handler through the spread, giving the cell a click target
    // that no keyboard user can reach.
    onClick={undefined}
  >
    <span className={HEAD_CONTENT_CLASS}>
      <Button
        className={sortableHeadButtonClassName(
          resolveTableAlign(align, numeric) === "end",
        )}
        onClick={onSort}
        type="button"
        variant="muted"
      >
        <TruncatedText>{children}</TruncatedText>
        <span aria-hidden className={SORT_ICON_SLOT_CLASS}>
          <SortDirectionIcon direction={sortDirection} />
        </span>
      </Button>
      {trailing}
    </span>
  </TableHead>
);

const TableCaption = ({
  className,
  ...props
}: React.ComponentProps<"caption">) => (
  <caption
    className={cn(
      "text-muted-foreground mt-4 text-sm in-data-[slot=frame]:my-4",
      className,
    )}
    data-slot="table-caption"
    {...props}
  />
);

export { TABLE_FIRST_LINE } from "./table-layout";
export type { TableFirstLine } from "./table-layout";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  SortableHead,
};
export type {
  SortDirection,
  TableAlign,
  TableDensity,
  TableHeadProps,
  TableCellProps,
  TableHeaderProps,
  TableInset,
  TableProps,
  TableScroll,
  TableTone,
};
