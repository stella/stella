import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ColumnPinningState,
  ColumnSizingState,
  OnChangeFn,
  RowSelectionState,
  SortingState,
  Updater,
} from "@tanstack/react-table";
import { produce } from "immer";
import { useDebouncedCallback } from "use-debounce";

const getValueFromUpdater = <
  T extends
    | ColumnSizingState
    | ColumnPinningState
    | RowSelectionState
    | SortingState,
>(
  updater: Updater<T>,
  prev: T,
): T => {
  return typeof updater === "function" ? updater(prev) : updater;
};

type UseTableStateReturn = {
  state: {
    columnSizing: ColumnSizingState;
    columnPinning: ColumnPinningState;
    sorting: SortingState;
    rowSelection: RowSelectionState;
  };
  onColumnSizingChange: OnChangeFn<ColumnSizingState>;
  onColumnPinningChange: OnChangeFn<ColumnPinningState>;
  onSortingChange: OnChangeFn<SortingState>;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
};

export const useTableState = (): UseTableStateReturn => {
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/",
  });
  const [initialColumnSizing, columnPinning, sorting, rowSelection] = useSearch(
    {
      from: "/_protected/workspaces/$workspaceId/",
      select: (s) =>
        [s.columnSizing, s.columnPinning, s.sorting, s.rowSelection] as const,
    },
  );
  const [columnSizing, setColumnSizing] =
    useState<ColumnSizingState>(initialColumnSizing);

  const onUpdateColumnSizing: OnChangeFn<ColumnSizingState> = (updater) => {
    return navigate({
      search: (searchState) => {
        const nextState = produce(searchState, (s) => {
          s.columnSizing = getValueFromUpdater(updater, s.columnSizing);
        });

        return nextState;
      },
    });
  };

  const columnSizingTimeout = 100;
  const updateColumnSizing = useDebouncedCallback(
    onUpdateColumnSizing,
    columnSizingTimeout,
  );

  const onColumnSizingChange: OnChangeFn<ColumnSizingState> = (updater) => {
    setColumnSizing(updater);
    updateColumnSizing(updater);
  };

  const onColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    return navigate({
      search: (searchState) => {
        const nextState = produce(searchState, (s) => {
          s.columnPinning =
            getValueFromUpdater(updater, { left: s.columnPinning }).left ?? [];
        });

        return nextState;
      },
    });
  };

  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    return navigate({
      search: (searchState) => {
        const nextState = produce(searchState, (s) => {
          s.sorting = getValueFromUpdater(updater, s.sorting);
        });

        return nextState;
      },
    });
  };

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    return navigate({
      search: (searchState) => {
        const nextState = produce(searchState, (s) => {
          s.rowSelection = getValueFromUpdater(updater, s.rowSelection);
        });

        return nextState;
      },
    });
  };

  return {
    state: {
      columnSizing,
      columnPinning: { left: columnPinning },
      sorting,
      rowSelection,
    },
    onColumnSizingChange,
    onColumnPinningChange,
    onSortingChange,
    onRowSelectionChange,
  };
};
