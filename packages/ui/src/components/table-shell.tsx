import type * as React from "react";

import { cn } from "../lib/utils";
import { InlineSkeleton } from "./skeleton";
import {
  resolveTableAlign,
  TABLE_ALIGN_CLASS,
  TableCellFace,
} from "./table-cell";
import type { TableAlign, TableTone } from "./table-cell";

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

/**
 * How tightly a table sets its cells.
 *
 * `default` is a data table: padded cells on one line, rows that light up
 * under the pointer. `compact` is a small reading table inside a card or a
 * review (a term set against a standard, a presence matrix): cells sit at
 * text leading with no side padding, headings keep a trailing gap so a
 * right-aligned heading never touches the next column, values wrap, and rows
 * do not highlight because nothing in them is a row-wide target. A row
 * header (`<TableHead scope="row">`) in a compact body reads as the row's
 * first cell rather than as a column heading.
 */
type TableDensity = "default" | "compact";

type TableProps = React.ComponentProps<"table"> & {
  density?: TableDensity;
  inset?: TableInset;
  scroll?: TableScroll;
};

const Table = ({
  className,
  density = "default",
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
      data-density={density}
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

const TableRow = ({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"tr"> & { tone?: TableTone | undefined }) => (
  <tr
    className={cn(
      "hover:bg-muted/72 data-[state=selected]:bg-muted/72 border-b in-data-[density=compact]:hover:bg-transparent in-data-[slot=frame]:hover:bg-transparent in-data-[slot=frame]:data-[state=selected]:bg-transparent",
      tone === "muted" && "text-muted-foreground",
      className,
    )}
    data-slot="table-row"
    {...props}
  />
);

// The obsolete `align` attribute of th/td gives way to the alignment prop.
type TableHeadProps = Omit<React.ComponentProps<"th">, "align"> & {
  align?: TableAlign | undefined;
  /**
   * Heads a column of figures: tabular numerals, like its cells, set to the
   * end unless `align` says otherwise.
   */
  numeric?: boolean | undefined;
};

const TableHead = ({
  className,
  align,
  numeric = false,
  ...props
}: TableHeadProps) => (
  <th
    className={cn(
      "text-muted-foreground h-10 px-2.5 align-middle leading-none font-medium whitespace-nowrap in-data-[inset=card]:px-4 has-[[role=checkbox]]:w-px has-[[role=checkbox]]:pe-0",
      "in-data-[density=compact]:h-auto in-data-[density=compact]:px-0 in-data-[density=compact]:py-1 in-data-[density=compact]:pe-3 in-data-[density=compact]:text-xs",
      "in-data-[density=compact]:[tbody_&]:py-1.5 in-data-[density=compact]:[tbody_&]:text-sm in-data-[density=compact]:[tbody_&]:leading-6 in-data-[density=compact]:[tbody_&]:font-normal in-data-[density=compact]:[tbody_&]:whitespace-normal in-data-[density=compact]:[tbody_&]:text-inherit",
      TABLE_ALIGN_CLASS[resolveTableAlign(align, numeric) ?? "start"],
      numeric && "tabular-nums",
      className,
    )}
    data-slot="table-head"
    {...props}
  />
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

type TableSkeletonColumn = {
  id: string;
  className?: string | undefined;
  align?: TableAlign | undefined;
} & ({ bar: string } | { placeholder: React.ReactNode });

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
];

/** Rows that share the table's cell geometry and its caller's column order. */
const TableSkeletonRows = ({
  columns,
  count = 5,
  rowClassName,
}: {
  columns: readonly TableSkeletonColumn[];
  /** Rows to draw, clamped to the reserved placeholder keys. */
  count?: number | undefined;
  rowClassName?: string | undefined;
}) =>
  SKELETON_ROW_KEYS.slice(0, Math.max(0, count)).map((rowKey) => (
    <TableRow aria-hidden="true" className={rowClassName} key={rowKey}>
      {columns.map((column) => (
        <TableCellFace
          align={column.align}
          className={column.className}
          key={column.id}
        >
          {"bar" in column ? (
            <span className="inline-flex h-8 items-center sm:h-7">
              <InlineSkeleton className={cn("h-3.5 max-w-full", column.bar)} />
            </span>
          ) : (
            column.placeholder
          )}
        </TableCellFace>
      ))}
    </TableRow>
  ));

export {
  Table,
  TableBody,
  TableCaption,
  TableCellFace,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
};
export type {
  TableAlign,
  TableDensity,
  TableHeadProps,
  TableHeaderProps,
  TableInset,
  TableProps,
  TableScroll,
  TableTone,
};
