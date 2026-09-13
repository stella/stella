/**
 * The controlled state a workspace table runs on.
 *
 * Everything a reader arranges — which columns show, in what order, pinned
 * how wide, what is picked, how the rows are ordered — is handed in as a
 * persistence object rather than read from a saved view, because the two hosts
 * keep it in different places: a matter saves it for everyone working the
 * matter, a page of public results keeps it in the reader's own browser. The
 * table, its header menus and its column chooser know neither.
 */

import { useState } from "react";

import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
  OnChangeFn,
  RowSelectionState,
  SortingState,
  Updater,
} from "@tanstack/react-table";
import { useDebouncedCallback } from "use-debounce";

import {
  createColumnOrderState,
  createColumnPinningState,
  createColumnVisibilityState,
  getPersistedColumnOrder,
  getPersistedColumnPinning,
  getPersistedHiddenColumnIds,
} from "@/components/workspaces/table/use-table-state.logic";
import type { TableColumnLayout } from "@/lib/workspaces/column-layout";

const COLUMN_SIZING_DEBOUNCE_MS = 100;

/** Nothing sorts, and the same nothing on every render. */
const NO_SORTING: SortingState = [];

/** How wide each column was dragged, and where that is kept. */
export type TableColumnSizingLayout = {
  sizing: ColumnSizingState;
  onChange: (sizing: ColumnSizingState) => void;
};

/**
 * A width the reader has dragged but the store has not heard yet, over the
 * stored map it was dragged against. Naming that map is what makes the
 * override lapse on its own: the moment the store hands over a different one,
 * this width is answering a question nobody is asking any more.
 */
type PendingColumnSizing = {
  over: ColumnSizingState;
  sizing: ColumnSizingState;
};

/** Which rows are picked, and how that is published. */
type TableRowSelectionLayout = {
  selection: RowSelectionState;
  onChange: (updater: Updater<RowSelectionState>) => void;
};

/** How the rows are ordered, and how a header changes that. */
type TableSortingLayout = {
  sorts: SortingState;
  onChange: (sorts: SortingState) => void;
};

export type UseTableStateProps = {
  columnLayout: TableColumnLayout;
  columnSizing: TableColumnSizingLayout;
  rowSelection: TableRowSelectionLayout;
  /**
   * Null where no column decides the order: a results page is ordered by its
   * search, so the table is never handed a listener a header could reach.
   */
  sorting: TableSortingLayout | null;
};

export const useTableState = ({
  columnLayout,
  columnSizing: storedColumnSizing,
  rowSelection,
  sorting,
}: UseTableStateProps) => {
  // Resizing publishes on every pointer move; the pending width keeps the drag
  // at frame rate and the store hears the settled one. Everything else is read
  // straight off the store on every render, and so is this the moment the
  // store moves: widths arriving after hydration, and the widths of another
  // matter table or another jurisdiction, are followed exactly the way the
  // order and the hidden set are.
  const [pendingColumnSizing, setPendingColumnSizing] =
    useState<PendingColumnSizing | null>(null);
  const columnSizing: ColumnSizingState =
    pendingColumnSizing !== null &&
    pendingColumnSizing.over === storedColumnSizing.sizing
      ? pendingColumnSizing.sizing
      : storedColumnSizing.sizing;

  // The listener travels with the width rather than being closed over, so a
  // publish that lands after the reader has moved on still reaches the store
  // the drag was made against instead of writing those widths into the next.
  const publishColumnSizing = useDebouncedCallback(
    (publish: (sizing: ColumnSizingState) => void, sizing: ColumnSizingState) =>
      publish(sizing),
    COLUMN_SIZING_DEBOUNCE_MS,
  );

  const onColumnSizingChange: OnChangeFn<ColumnSizingState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnSizing) : updater;
    setPendingColumnSizing({ over: storedColumnSizing.sizing, sizing: data });
    publishColumnSizing(storedColumnSizing.onChange, data);
  };

  const columnPinning: ColumnPinningState = createColumnPinningState(
    columnLayout.pinned,
  );

  const onColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnPinning) : updater;
    columnLayout.onChange({ pinned: getPersistedColumnPinning(data) });
  };

  const columnOrder: ColumnOrderState = createColumnOrderState(
    columnLayout.order,
  );

  const onColumnOrderChange: OnChangeFn<ColumnOrderState> = (updater) => {
    const data = typeof updater === "function" ? updater(columnOrder) : updater;
    columnLayout.onChange({ order: getPersistedColumnOrder(data) });
  };

  const columnVisibility: ColumnVisibilityState = createColumnVisibilityState(
    columnLayout.hidden,
  );

  const onColumnVisibilityChange: OnChangeFn<ColumnVisibilityState> = (
    updater,
  ) => {
    const data =
      typeof updater === "function" ? updater(columnVisibility) : updater;

    columnLayout.onChange({ hidden: getPersistedHiddenColumnIds(data) });
  };

  const onSortingChange: OnChangeFn<SortingState> | undefined =
    sorting === null
      ? undefined
      : (updater) => {
          sorting.onChange(
            typeof updater === "function" ? updater(sorting.sorts) : updater,
          );
        };

  return {
    state: {
      columnSizing,
      columnOrder,
      columnPinning,
      columnVisibility,
      sorting: sorting?.sorts ?? NO_SORTING,
      rowSelection: rowSelection.selection,
    },
    listeners: {
      onColumnSizingChange,
      onColumnOrderChange,
      onColumnPinningChange,
      onColumnVisibilityChange,
      onRowSelectionChange: rowSelection.onChange,
      ...(onSortingChange === undefined ? {} : { onSortingChange }),
    },
  };
};
