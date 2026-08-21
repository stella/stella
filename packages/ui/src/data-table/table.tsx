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
          onKeyDown={mergeHandlers(
            interactiveProps?.onKeyDown,
            rowProps?.onKeyDown,
          )}
        >
          {columns.map((column) => (
            <TableCell
              className={resolveClassName(column.cellClassName, item)}
              key={column.id}
            >
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
  "aria-label": rowAction.getAriaLabel(item),
  className: cn(
    "focus-visible:outline-ring cursor-pointer focus-visible:outline focus-visible:outline-2",
    rowAction.getClassName?.(item),
  ),
  onClick: () => rowAction.onSelect(item),
  onKeyDown: (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    rowAction.onSelect(item);
  },
  role: "button",
  tabIndex: 0,
});

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
