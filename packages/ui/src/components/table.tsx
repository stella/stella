import type * as React from "react";

import { ArrowDownIcon, ArrowUpIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";
import {
  resolveTableAlign,
  tableCellClassName,
  TableCellFace,
} from "./table-cell";
import type { TableCellFaceProps } from "./table-cell";
import { TableHead } from "./table-shell";
import type { TableHeadProps } from "./table-shell";
import { TruncatedText } from "./truncated-text";

type TableCellProps = TableCellFaceProps & {
  /**
   * Cuts text that overflows the cell with an ellipsis; the caller bounds the
   * cell's width (`max-w-xs`).
   */
  truncate?: boolean;
};

const TableCell = ({
  className,
  align,
  tone,
  numeric,
  truncate = false,
  flush = false,
  children,
  ...props
}: TableCellProps) => {
  if (truncate) {
    // The cell itself is cut, so it stays a table cell rather than the
    // block TruncatedText makes of a single line.
    return (
      <TruncatedText
        className={cn(
          "table-cell",
          tableCellClassName({ align, className, flush, numeric, tone }),
        )}
        data-slot="table-cell"
        render={<td {...props} />}
      >
        {children}
      </TruncatedText>
    );
  }
  return (
    <TableCellFace
      align={align}
      className={className}
      flush={flush}
      numeric={numeric}
      tone={tone}
      {...props}
    >
      {children}
    </TableCellFace>
  );
};

type SortDirection = "asc" | "desc" | null;

type SortableHeadProps = Omit<TableHeadProps, "onClick"> & {
  sortDirection?: SortDirection;
  onSort: () => void;
  /** Rendered next to the sort button inside the same cell (e.g. filter icon). */
  trailing?: React.ReactNode;
};

/**
 * A column head the reader sorts by. The label is a quiet `Button`, so it
 * has the design system's hover band, focus ring and touch target; its
 * padding is pulled back so the label still lines up with the cells below.
 * In an end-aligned (numeric) column the arrow sits before the label, keeping
 * the label flush with the figures.
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
}: SortableHeadProps) => {
  const endAligned = resolveTableAlign(align, numeric) === "end";
  let ariaSort: "ascending" | "descending" | "none" = "none";
  if (sortDirection === "asc") {
    ariaSort = "ascending";
  } else if (sortDirection === "desc") {
    ariaSort = "descending";
  }
  let sortIcon: React.ReactNode = null;
  if (sortDirection === "asc") {
    sortIcon = <ArrowUpIcon className="size-3" />;
  } else if (sortDirection === "desc") {
    sortIcon = <ArrowDownIcon className="size-3" />;
  }
  return (
    <TableHead
      align={align}
      aria-sort={ariaSort}
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
      <span className="inline-flex items-center gap-1">
        <Button
          // The button's inline padding equals the head's, and the negative
          // margin cancels exactly that: the label lines up with the cells and
          // the button never reaches past the table's edge, where a scrolling
          // container could not reveal it.
          className={cn(
            "min-w-0 gap-1 px-2.5",
            endAligned ? "-me-2.5 flex-row-reverse" : "-ms-2.5",
          )}
          onClick={onSort}
          type="button"
          variant="muted"
        >
          <TruncatedText>{children}</TruncatedText>
          <span aria-hidden className="inline-flex w-3 shrink-0 justify-center">
            {sortIcon}
          </span>
        </Button>
        {trailing}
      </span>
    </TableHead>
  );
};

export { TABLE_FIRST_LINE } from "./table-layout";
export type { TableFirstLine } from "./table-layout";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCaption,
} from "./table-shell";
export type {
  TableAlign,
  TableDensity,
  TableHeadProps,
  TableHeaderProps,
  TableInset,
  TableProps,
  TableScroll,
  TableTone,
} from "./table-shell";
export { TableCell, SortableHead };
export type { SortDirection, TableCellProps };
