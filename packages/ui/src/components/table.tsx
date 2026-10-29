import type * as React from "react";

import { ArrowDownIcon, ArrowUpIcon } from "../icons";
import { cn } from "../lib/utils";

/**
 * How far cells pad their content from the column edges.
 *
 * `card` pads 16px, the inset of a card's header and body, so a table set
 * directly inside a bordered card lines its columns up with the card's title.
 */
type TableInset = "default" | "card";

/**
 * Who scrolls a table wider or taller than its box. `self` wraps it in its own
 * horizontal scroller. `parent` renders the bare table for a page that already
 * scrolls it (a `ScrollArea`, a scrolling pane): a scroller of its own would
 * become the reference box of a sticky header and stop it from sticking.
 */
type TableScroll = "self" | "parent";

type TableProps = React.ComponentProps<"table"> & {
  inset?: TableInset;
  scroll?: TableScroll;
};

const Table = ({
  className,
  inset = "default",
  scroll = "self",
  ...props
}: TableProps) => {
  const table = (
    <table
      className={cn(
        "w-full caption-bottom text-sm in-data-[slot=frame]:border-separate in-data-[slot=frame]:border-spacing-0",
        className,
      )}
      data-inset={inset}
      data-slot="table"
      {...props}
    />
  );
  if (scroll === "parent") {
    return table;
  }
  return (
    <div
      className="relative w-full overflow-x-auto"
      data-slot="table-container"
    >
      {table}
    </div>
  );
};

type TableHeaderProps = React.ComponentProps<"thead"> & {
  /**
   * `muted` lays the header row on a muted band, separating it from the rows
   * of a long list.
   */
  surface?: "plain" | "muted";
  /**
   * Keeps the header in view while the rows scroll under it, on a translucent
   * muted band. The table must scroll with its parent (`scroll="parent"`).
   */
  sticky?: boolean;
};

const TableHeader = ({
  className,
  surface = "plain",
  sticky = false,
  ...props
}: TableHeaderProps) => (
  <thead
    className={cn(
      "[&_tr]:border-b in-data-[slot=frame]:**:[th]:h-9 in-data-[slot=frame]:*:[tr]:border-none in-data-[slot=frame]:*:[tr]:hover:bg-transparent",
      surface === "muted" && "bg-muted/50",
      sticky && "bg-muted/80 sticky top-0 z-10 backdrop-blur",
      className,
    )}
    data-slot="table-header"
    {...props}
  />
);

const TableBody = ({ className, ...props }: React.ComponentProps<"tbody">) => (
  <tbody
    className={cn(
      "in-data-[slot=frame]:*:[tr]:*:[td]:bg-background in-data-[slot=frame]:*:[tr]:data-[state=selected]:*:[td]:bg-muted/72 relative before:pointer-events-none before:absolute before:inset-px before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] not-in-data-[slot=frame]:before:hidden in-data-[slot=frame]:rounded-xl in-data-[slot=frame]:shadow-xs/5 dark:before:shadow-[0_-1px_--theme(--color-white/8%)] [&_tr:last-child]:border-0 in-data-[slot=frame]:*:[tr]:border-0 in-data-[slot=frame]:*:[tr]:*:[td]:border-b in-data-[slot=frame]:*:[tr]:*:[td]:bg-clip-padding in-data-[slot=frame]:*:[tr]:first:*:[td]:first:rounded-ss-xl in-data-[slot=frame]:*:[tr]:*:[td]:first:border-s in-data-[slot=frame]:*:[tr]:first:*:[td]:border-t in-data-[slot=frame]:*:[tr]:last:*:[td]:last:rounded-ee-xl in-data-[slot=frame]:*:[tr]:*:[td]:last:border-e in-data-[slot=frame]:*:[tr]:first:*:[td]:last:rounded-se-xl in-data-[slot=frame]:*:[tr]:last:*:[td]:first:rounded-es-xl in-data-[slot=frame]:*:[tr]:hover:*:[td]:bg-transparent",
      className,
    )}
    data-slot="table-body"
    {...props}
  />
);

const TableFooter = ({
  className,
  ...props
}: React.ComponentProps<"tfoot">) => (
  <tfoot
    className={cn(
      "bg-muted/72 border-t font-medium in-data-[slot=frame]:border-none in-data-[slot=frame]:bg-transparent in-data-[slot=frame]:*:[tr]:hover:bg-transparent [&>tr]:last:border-b-0",
      className,
    )}
    data-slot="table-footer"
    {...props}
  />
);

/**
 * `muted` greys out a row or a cell whose value no longer counts (a voided
 * payment) or that only supports its neighbours (a secondary column).
 */
type TableTone = "default" | "muted";

const TableRow = ({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"tr"> & { tone?: TableTone | undefined }) => (
  <tr
    className={cn(
      "hover:bg-muted/72 data-[state=selected]:bg-muted/72 border-b in-data-[slot=frame]:hover:bg-transparent in-data-[slot=frame]:data-[state=selected]:bg-transparent",
      tone === "muted" && "text-muted-foreground",
      className,
    )}
    data-slot="table-row"
    {...props}
  />
);

/**
 * Where a column sets its content. `end` lines up figures and amounts;
 * `start` is the default reading edge.
 */
type TableAlign = "start" | "center" | "end";

const TABLE_ALIGN_CLASS = {
  center: "text-center",
  end: "text-end",
  start: "text-start",
} as const satisfies Record<TableAlign, string>;

// The obsolete `align` attribute of th/td gives way to the alignment prop.
type TableHeadProps = Omit<React.ComponentProps<"th">, "align"> & {
  align?: TableAlign | undefined;
  /** Heads a column of figures: tabular numerals, like its cells. */
  numeric?: boolean | undefined;
};

const TableHead = ({
  className,
  align = "start",
  numeric = false,
  ...props
}: TableHeadProps) => (
  <th
    className={cn(
      "text-muted-foreground h-10 px-2.5 align-middle leading-none font-medium whitespace-nowrap in-data-[inset=card]:px-4 has-[[role=checkbox]]:w-px has-[[role=checkbox]]:pe-0",
      TABLE_ALIGN_CLASS[align],
      numeric && "tabular-nums",
      className,
    )}
    data-slot="table-head"
    {...props}
  />
);

type TableCellProps = Omit<React.ComponentProps<"td">, "align"> & {
  align?: TableAlign | undefined;
  tone?: TableTone | undefined;
  /** Figures set in tabular numerals, so digits line up down the column. */
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
  ...props
}: TableCellProps) => (
  <td
    className={cn(
      "align-middle leading-none whitespace-nowrap has-[[role=checkbox]]:pe-0",
      flush
        ? "p-0"
        : "p-2.5 in-data-[inset=card]:px-4 in-data-[slot=frame]:first:p-[calc(--spacing(2.5)-1px)] in-data-[slot=frame]:last:p-[calc(--spacing(2.5)-1px)]",
      align !== undefined && TABLE_ALIGN_CLASS[align],
      tone === "muted" && "text-muted-foreground",
      numeric && "tabular-nums",
      truncate && "truncate",
      className,
    )}
    data-slot="table-cell"
    {...props}
  />
);

type SortDirection = "asc" | "desc" | null;

type SortableHeadProps = Omit<TableHeadProps, "onClick"> & {
  sortDirection?: SortDirection;
  onSort: () => void;
  /** Rendered next to the sort button inside the same cell (e.g. filter icon). */
  trailing?: React.ReactNode;
};

const SortableHead = ({
  children,
  sortDirection = null,
  onSort,
  trailing,
  className,
  ...props
}: SortableHeadProps) => {
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
      aria-sort={ariaSort}
      className={className}
      {...props}
      // After the spread on purpose: the props type omits `onClick` because the
      // sort button below owns activation, but omitting it only rejects a
      // literal attribute. A props object typed wider stays assignable and
      // carries the handler through the spread, giving the cell a click target
      // that no keyboard user can reach.
      onClick={undefined}
    >
      <span className="inline-flex items-center gap-1">
        <button
          className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 font-medium select-none"
          onClick={onSort}
          type="button"
        >
          <span className="truncate">{children}</span>
          <span aria-hidden className="inline-flex w-3 shrink-0 justify-center">
            {sortIcon}
          </span>
        </button>
        {trailing}
      </span>
    </TableHead>
  );
};

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
  TableHeadProps,
  TableCellProps,
  TableHeaderProps,
  TableInset,
  TableProps,
  TableScroll,
  TableTone,
};
