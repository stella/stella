import type { HTMLAttributes, ReactNode } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/table";
import { cn } from "../lib/utils";

type RowProps = Omit<HTMLAttributes<HTMLTableRowElement>, "children">;

const INTERACTIVE_DESCENDANT_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "[contenteditable='true']",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='listbox']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='searchbox']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[role='treeitem']",
  "[tabindex]:not([tabindex='-1'])",
  "[data-data-table-stop-row-action]",
].join(",");

export type DataTableAriaSort = "ascending" | "descending" | "none";

export type DataTableColumn<TItem> = {
  ariaSort?: DataTableAriaSort;
  cellClassName?: string | ((item: TItem) => string | undefined);
  header: ReactNode;
  headClassName?: string;
  id: string;
  render: (item: TItem) => ReactNode;
};

export type DataTableRowAction<TItem> = {
  getAriaLabel: (item: TItem) => string;
  getClassName?: (item: TItem) => string | undefined;
  onSelect: (item: TItem) => void;
};

export type DataTableProps<TItem> = {
  columns: readonly DataTableColumn<TItem>[];
  emptyLabel: string;
  getRowProps?: (item: TItem) => RowProps;
  isLoading?: boolean;
  loadingLabel: string;
  rowAction?: DataTableRowAction<TItem>;
  rowKey: (item: TItem) => string | number;
  rows: readonly TItem[];
};

export const DataTable = <TItem,>({
  columns,
  emptyLabel,
  getRowProps,
  isLoading = false,
  loadingLabel,
  rowAction,
  rowKey,
  rows,
}: DataTableProps<TItem>) => {
  let content: ReactNode;
  if (isLoading) {
    content = <StatusRow colSpan={columns.length} label={loadingLabel} />;
  } else if (rows.length === 0) {
    content = <StatusRow colSpan={columns.length} label={emptyLabel} />;
  } else {
    content = rows.map((item) => {
      const rowProps = getRowProps?.(item);
      const interactiveProps =
        rowAction === undefined
          ? undefined
          : interactiveRowProps(item, rowAction);

      return (
        <TableRow
          key={rowKey(item)}
          {...rowProps}
          {...interactiveProps}
          className={cn(interactiveProps?.className, rowProps?.className)}
          onClick={mergeHandlers(interactiveProps?.onClick, rowProps?.onClick)}
        >
          {columns.map((column, columnIndex) => (
            <TableCell
              className={cn(
                rowAction !== undefined && columnIndex === 0
                  ? "relative"
                  : undefined,
                resolveClassName(column.cellClassName, item),
              )}
              key={column.id}
            >
              {rowAction !== undefined && columnIndex === 0 ? (
                <button
                  className="focus-visible:bg-background focus-visible:ring-ring sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:inset-2 focus-visible:z-10 focus-visible:flex focus-visible:items-center focus-visible:rounded-md focus-visible:px-2 focus-visible:text-sm focus-visible:ring-2"
                  onClick={() => rowAction.onSelect(item)}
                  type="button"
                >
                  {rowAction.getAriaLabel(item)}
                </button>
              ) : null}
              {column.render(item)}
            </TableCell>
          ))}
        </TableRow>
      );
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead
              aria-sort={column.ariaSort}
              className={column.headClassName}
              key={column.id}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{content}</TableBody>
    </Table>
  );
};

const StatusRow = ({ colSpan, label }: { colSpan: number; label: string }) => (
  <TableRow>
    <TableCell
      className="text-muted-foreground h-24 text-center"
      colSpan={colSpan}
    >
      {label}
    </TableCell>
  </TableRow>
);

const resolveClassName = <TItem,>(
  value: string | ((item: TItem) => string | undefined) | undefined,
  item: TItem,
) => (typeof value === "function" ? value(item) : value);

const interactiveRowProps = <TItem,>(
  item: TItem,
  rowAction: DataTableRowAction<TItem>,
): RowProps => ({
  className: cn("cursor-pointer", rowAction.getClassName?.(item)),
  onClick: (event) => {
    if (!isDataTableRowActionTarget(event.currentTarget, event.target)) {
      return;
    }
    rowAction.onSelect(item);
  },
});

type ClosestEventTarget = EventTarget & {
  closest: (selector: string) => unknown;
};

const hasClosest = (target: EventTarget): target is ClosestEventTarget =>
  "closest" in target && typeof target.closest === "function";

export const isDataTableRowActionTarget = (
  row: EventTarget,
  target: EventTarget | null,
) => {
  if (target === row || target === null || !hasClosest(target)) {
    return true;
  }
  return target.closest(INTERACTIVE_DESCENDANT_SELECTOR) === null;
};

const mergeHandlers = <TElement,>(
  first: ((event: TElement) => void) | undefined,
  second: ((event: TElement) => void) | undefined,
) => {
  if (first === undefined) {
    return second;
  }
  if (second === undefined) {
    return first;
  }
  return (event: TElement) => {
    first(event);
    second(event);
  };
};
