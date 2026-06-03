import type * as React from "react";

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      className="relative w-full overflow-x-auto"
      data-slot="table-container"
    >
      <table
        className={cn(
          "w-full caption-bottom text-sm in-data-[slot=frame]:border-separate in-data-[slot=frame]:border-spacing-0",
          className,
        )}
        data-slot="table"
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn(
        "[&_tr]:border-b in-data-[slot=frame]:**:[th]:h-9 in-data-[slot=frame]:*:[tr]:border-none in-data-[slot=frame]:*:[tr]:hover:bg-transparent",
        className,
      )}
      data-slot="table-header"
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      className={cn(
        "in-data-[slot=frame]:*:[tr]:*:[td]:bg-background in-data-[slot=frame]:*:[tr]:data-[state=selected]:*:[td]:bg-muted/72 relative before:pointer-events-none before:absolute before:inset-px before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] not-in-data-[slot=frame]:before:hidden in-data-[slot=frame]:rounded-xl in-data-[slot=frame]:shadow-xs/5 dark:before:shadow-[0_-1px_--theme(--color-white/8%)] [&_tr:last-child]:border-0 in-data-[slot=frame]:*:[tr]:border-0 in-data-[slot=frame]:*:[tr]:*:[td]:border-b in-data-[slot=frame]:*:[tr]:*:[td]:bg-clip-padding in-data-[slot=frame]:*:[tr]:first:*:[td]:first:rounded-ss-xl in-data-[slot=frame]:*:[tr]:*:[td]:first:border-s in-data-[slot=frame]:*:[tr]:first:*:[td]:border-t in-data-[slot=frame]:*:[tr]:last:*:[td]:last:rounded-ee-xl in-data-[slot=frame]:*:[tr]:*:[td]:last:border-e in-data-[slot=frame]:*:[tr]:first:*:[td]:last:rounded-se-xl in-data-[slot=frame]:*:[tr]:last:*:[td]:first:rounded-es-xl in-data-[slot=frame]:*:[tr]:hover:*:[td]:bg-transparent",
        className,
      )}
      data-slot="table-body"
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn(
        "bg-muted/72 border-t font-medium in-data-[slot=frame]:border-none in-data-[slot=frame]:bg-transparent in-data-[slot=frame]:*:[tr]:hover:bg-transparent [&>tr]:last:border-b-0",
        className,
      )}
      data-slot="table-footer"
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "hover:bg-muted/72 data-[state=selected]:bg-muted/72 border-b transition-colors in-data-[slot=frame]:hover:bg-transparent in-data-[slot=frame]:data-[state=selected]:bg-transparent",
        className,
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "text-muted-foreground h-10 px-2.5 text-start align-middle leading-none font-medium whitespace-nowrap has-[[role=checkbox]]:w-px has-[[role=checkbox]]:pe-0",
        className,
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "p-2.5 align-middle leading-none whitespace-nowrap in-data-[slot=frame]:first:p-[calc(--spacing(2.5)-1px)] in-data-[slot=frame]:last:p-[calc(--spacing(2.5)-1px)] has-[[role=checkbox]]:pe-0",
        className,
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

type SortDirection = "asc" | "desc" | null;

type SortableHeadProps = Omit<React.ComponentProps<"th">, "onClick"> & {
  sortDirection?: SortDirection;
  onSort: () => void;
  /** Rendered next to the sort button inside the same cell (e.g. filter icon). */
  trailing?: React.ReactNode;
};

function SortableHead({
  children,
  sortDirection = null,
  onSort,
  trailing,
  className,
  ...props
}: SortableHeadProps) {
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
    <TableHead aria-sort={ariaSort} className={className} {...props}>
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
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      className={cn(
        "text-muted-foreground mt-4 text-sm in-data-[slot=frame]:my-4",
        className,
      )}
      data-slot="table-caption"
      {...props}
    />
  );
}

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
export type { SortDirection };
