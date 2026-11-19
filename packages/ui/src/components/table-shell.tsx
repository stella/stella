import type * as React from "react";

import { ArrowDownIcon, ArrowUpIcon } from "../icons";
import { cn } from "../lib/utils";
import { ButtonFace } from "./control-face";
import { TRUNCATED_TEXT_LINES_CLASS } from "./truncated-text-face";

/*
 * The table's own markup with no popup and no tooltip: the box, the header and
 * body, rows, heads and plain cells, and the face of a sortable head. `Table`,
 * `SortableHead` and the truncating cell (./table.tsx) are built from these,
 * so a loading view that draws the table it stands in for (header, column
 * widths, placeholder rows) can import them before the page's providers mount.
 */

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
      "hover:bg-muted/72 data-[state=selected]:bg-muted/72 border-b in-data-[density=compact]:hover:bg-transparent in-data-[slot=frame]:hover:bg-transparent in-data-[slot=frame]:data-[state=selected]:bg-transparent",
      tone === "muted" && "text-muted-foreground",
      className,
    )}
    data-slot="table-row"
    {...props}
  />
);

/**
 * Where a column sets its content. `end` lines up figures and amounts;
 * `start` is the default reading edge. A `numeric` head or cell sets to the
 * end unless it names an alignment, so a figures column needs one prop.
 */
type TableAlign = "start" | "center" | "end";

const TABLE_ALIGN_CLASS = {
  center: "text-center",
  end: "text-end",
  start: "text-start",
} as const satisfies Record<TableAlign, string>;

const resolveTableAlign = (
  align: TableAlign | undefined,
  numeric: boolean,
): TableAlign | undefined => align ?? (numeric ? "end" : undefined);

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

type TableCellClassOptions = {
  align?: TableAlign | undefined;
  tone?: TableTone | undefined;
  numeric?: boolean | undefined;
  flush?: boolean | undefined;
  className?: string | undefined;
};

/** A body cell's classes: its padding, alignment, tone and figures. */
const tableCellClassName = ({
  align,
  tone = "default",
  numeric = false,
  flush = false,
  className,
}: TableCellClassOptions): string => {
  const resolvedAlign = resolveTableAlign(align, numeric);
  return cn(
    "align-middle leading-none whitespace-nowrap has-[[role=checkbox]]:pe-0",
    flush
      ? "p-0"
      : "p-2.5 in-data-[density=compact]:px-0 in-data-[density=compact]:py-1.5 in-data-[inset=card]:px-4 in-data-[slot=frame]:first:p-[calc(--spacing(2.5)-1px)] in-data-[slot=frame]:last:p-[calc(--spacing(2.5)-1px)]",
    "in-data-[density=compact]:leading-6 in-data-[density=compact]:whitespace-normal",
    resolvedAlign !== undefined && TABLE_ALIGN_CLASS[resolvedAlign],
    tone === "muted" && "text-muted-foreground",
    numeric && "tabular-nums",
    className,
  );
};

type TableShellCellProps = Omit<React.ComponentProps<"td">, "align"> &
  Omit<TableCellClassOptions, "className"> & {
    className?: string | undefined;
  };

/** A body cell that never cuts its text (`TableCell` without `truncate`). */
const TableShellCell = ({
  align,
  className,
  flush,
  numeric,
  tone,
  ...props
}: TableShellCellProps) => (
  <td
    className={tableCellClassName({ align, className, flush, numeric, tone })}
    data-slot="table-cell"
    {...props}
  />
);

type SortDirection = "asc" | "desc" | null;

/** The `aria-sort` a sortable head carries for its direction. */
const ariaSortOf = (
  direction: SortDirection,
): "ascending" | "descending" | "none" => {
  if (direction === "asc") {
    return "ascending";
  }
  if (direction === "desc") {
    return "descending";
  }
  return "none";
};

/** The arrow after a sorted head's label, or nothing. */
const SortDirectionIcon = ({ direction }: { direction: SortDirection }) => {
  if (direction === "asc") {
    return <ArrowUpIcon className="size-3" />;
  }
  if (direction === "desc") {
    return <ArrowDownIcon className="size-3" />;
  }
  return null;
};

/**
 * The sort button's own classes inside a head. Its inline padding equals the
 * head's, and the negative margin cancels exactly that: the label lines up
 * with the cells and the button never reaches past the table's edge, where a
 * scrolling container could not reveal it. In an end-aligned (numeric) column
 * the arrow sits before the label, keeping the label flush with the figures.
 */
const sortableHeadButtonClassName = (endAligned: boolean): string =>
  cn(
    "min-w-0 gap-1 px-2.5",
    endAligned ? "-me-2.5 flex-row-reverse" : "-ms-2.5",
  );

/** The arrow's slot: the same width with or without an arrow in it. */
const SORT_ICON_SLOT_CLASS = "inline-flex w-3 shrink-0 justify-center";

/** A head's label with what follows it (a filter trigger), on one line. */
const HEAD_CONTENT_CLASS = "inline-flex items-center gap-1";

/**
 * A head's label in a loading face, cut to one line as `TruncatedText` cuts
 * the loaded label (without its tooltip, which a face has no use for).
 */
const TableHeadLabel = ({ children }: { children: React.ReactNode }) => (
  <span className={TRUNCATED_TEXT_LINES_CLASS[1]}>{children}</span>
);

type SortableHeadFaceProps = Omit<TableHeadProps, "onClick" | "children"> & {
  children: React.ReactNode;
  sortDirection?: SortDirection;
  /** Drawn next to the label, where the head's trailing control goes. */
  trailing?: React.ReactNode;
};

/**
 * A sortable head before its page has loaded: the label in the sort button's
 * face and the arrow in its slot, with no behaviour.
 */
const SortableHeadFace = ({
  align,
  children,
  numeric = false,
  sortDirection = null,
  trailing,
  ...props
}: SortableHeadFaceProps) => (
  <TableHead
    align={align}
    aria-sort={ariaSortOf(sortDirection)}
    numeric={numeric}
    {...props}
    onClick={undefined}
  >
    <span className={HEAD_CONTENT_CLASS}>
      <ButtonFace
        className={sortableHeadButtonClassName(
          resolveTableAlign(align, numeric) === "end",
        )}
        size="default"
        variant="muted"
      >
        <TableHeadLabel>{children}</TableHeadLabel>
        <span aria-hidden className={SORT_ICON_SLOT_CLASS}>
          <SortDirectionIcon direction={sortDirection} />
        </span>
      </ButtonFace>
      {trailing}
    </span>
  </TableHead>
);

export {
  HEAD_CONTENT_CLASS,
  SORT_ICON_SLOT_CLASS,
  SortableHeadFace,
  SortDirectionIcon,
  Table,
  TableBody,
  TableFooter,
  TableHead,
  TableHeader,
  TableHeadLabel,
  TableRow,
  TableShellCell,
  ariaSortOf,
  resolveTableAlign,
  sortableHeadButtonClassName,
  tableCellClassName,
};
export type {
  SortDirection,
  TableAlign,
  TableDensity,
  TableHeadProps,
  TableHeaderProps,
  TableInset,
  TableProps,
  TableScroll,
  TableShellCellProps,
  TableTone,
};
