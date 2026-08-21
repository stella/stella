import type { HTMLAttributes, ReactNode } from "react";

import { Button } from "../components/button";
import { Skeleton } from "../components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/table";
import { cn } from "../lib/utils";

export const DataTable = <TItem,>({
  columns,
  emptyLabel,
  getRowProps,
  isLoading = false,
  loadingLabel,
  loadingRowCount = DEFAULT_LOADING_ROW_COUNT,
  rowAction,
  rowKey,
  rows,
}: DataTableProps<TItem>) => {
  let content: ReactNode;
  if (isLoading) {
    content = (
      <LoadingRows
        columns={columns}
        label={loadingLabel}
        rowCount={loadingRowCount}
      />
    );
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
                <Button
                  className="focus-visible:bg-background focus-visible:ring-ring sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:inset-2 focus-visible:z-10 focus-visible:flex focus-visible:items-center focus-visible:rounded-md focus-visible:px-2 focus-visible:text-sm focus-visible:ring-2"
                  onClick={() => rowAction.onSelect(item)}
                  size="xs"
                  variant="ghost"
                >
                  {rowAction.getAriaLabel(item)}
                </Button>
              ) : null}
              {column.render(item)}
            </TableCell>
          ))}
        </TableRow>
      );
    });
  }

  return (
    <Table aria-busy={isLoading}>
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

type RowProps = Omit<HTMLAttributes<HTMLTableRowElement>, "children">;

const DEFAULT_LOADING_ROW_COUNT = 3;
const MAX_LOADING_ROW_COUNT = 20;

const INTERACTIVE_DESCENDANT_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "[contenteditable]:not([contenteditable='false'])",
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
  columns: readonly [DataTableColumn<TItem>, ...DataTableColumn<TItem>[]];
  emptyLabel: string;
  getRowProps?: (item: TItem) => RowProps;
  isLoading?: boolean;
  loadingLabel: string;
  loadingRowCount?: number;
  rowAction?: DataTableRowAction<TItem>;
  rowKey: (item: TItem) => string | number;
  rows: readonly TItem[];
};

const LoadingRows = <TItem,>({
  columns,
  label,
  rowCount,
}: {
  columns: readonly DataTableColumn<TItem>[];
  label: string;
  rowCount: number;
}) =>
  Array.from({ length: resolveLoadingRowCount(rowCount) }, (_, rowIndex) => (
    <TableRow key={rowIndex}>
      {columns.map((column, columnIndex) => (
        <TableCell key={column.id}>
          {rowIndex === 0 && columnIndex === 0 ? (
            <span className="sr-only" role="status">
              {label}
            </span>
          ) : null}
          <Skeleton aria-hidden="true" className="h-4 w-full" />
        </TableCell>
      ))}
    </TableRow>
  ));

const resolveLoadingRowCount = (rowCount: number) =>
  Number.isFinite(rowCount) && rowCount > 0
    ? Math.min(MAX_LOADING_ROW_COUNT, Math.max(1, Math.floor(rowCount)))
    : DEFAULT_LOADING_ROW_COUNT;

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

type ContainsEventTarget = EventTarget & {
  contains: (target: EventTarget | null) => boolean;
};

const hasClosest = (target: EventTarget): target is ClosestEventTarget =>
  "closest" in target && typeof target.closest === "function";

const hasContains = (target: EventTarget): target is ContainsEventTarget =>
  "contains" in target && typeof target.contains === "function";

export const isDataTableRowActionTarget = (
  row: EventTarget,
  target: EventTarget | null,
) => {
  if (target === row) {
    return true;
  }
  if (target === null || !hasContains(row) || !row.contains(target)) {
    return false;
  }
  if (!hasClosest(target)) {
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
