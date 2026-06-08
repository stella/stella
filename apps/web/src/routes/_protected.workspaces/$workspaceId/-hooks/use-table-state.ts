import { useMemo, useState } from "react";

import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
  OnChangeFn,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { useDebouncedCallback } from "use-debounce";
import { useShallow } from "zustand/shallow";

import type { WorkspaceView } from "@/lib/types";
import type { TableContentMode } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import {
  createColumnOrderState,
  createColumnPinningState,
  createColumnVisibilityState,
  getPersistedColumnOrder,
  getPersistedColumnPinning,
  getPersistedHiddenColumnIds,
  omitUtilityColumnSizing,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state.logic";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";

const EMPTY_ROW_SELECTION: RowSelectionState = {};
const COLUMN_SIZING_DEBOUNCE_MS = 100;

type UseTableStateProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

export const useTableState = ({ workspaceId, view }: UseTableStateProps) => {
  const viewId = view.id;
  const updateView = useUpdateView(workspaceId);

  const storedColumnSizing = useTableStore(
    useShallow((s) => {
      const sizing = s.columnSizing.get(viewId) ?? {};
      return omitUtilityColumnSizing(sizing);
    }),
  );
  const setStoredColumnSizing = useTableStore((s) => s.setColumnSizing);
  const contentMode = useTableStore((s) => s.contentMode[viewId] ?? "tight");
  const setContentMode = useTableStore((s) => s.setContentMode);
  const [columnSizing, setColumnSizing] = useState(storedColumnSizing);

  const debouncedSetStoredColumnSizing = useDebouncedCallback(
    (data: ColumnSizingState) => {
      setStoredColumnSizing(viewId, data);
    },
    COLUMN_SIZING_DEBOUNCE_MS,
  );

  const onColumnSizingChange: OnChangeFn<ColumnSizingState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnSizing) : updater;
    setColumnSizing(data);
    debouncedSetStoredColumnSizing(data);
  };

  const sorting = useMemo<SortingState>(
    () =>
      view.layout.sorts.map((s) => ({
        id: s.propertyId,
        desc: s.desc,
      })),
    [view.layout.sorts],
  );

  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    const data = typeof updater === "function" ? updater(sorting) : updater;
    updateView.mutate({
      viewId,
      layout: {
        ...view.layout,
        sorts: data.map((s) => ({
          propertyId: s.id,
          desc: s.desc,
        })),
      },
    });
  };

  const columnPinning = useMemo<ColumnPinningState>(
    () => createColumnPinningState(view.layout.columnPinning),
    [view.layout.columnPinning],
  );

  const onColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnPinning) : updater;
    const pinned = getPersistedColumnPinning(data);
    updateView.mutate({
      viewId,
      layout: { ...view.layout, columnPinning: pinned },
    });
  };

  const columnOrder = useMemo<ColumnOrderState>(
    () => createColumnOrderState(view.layout.columnOrder),
    [view.layout.columnOrder],
  );

  const onColumnOrderChange: OnChangeFn<ColumnOrderState> = (updater) => {
    const data = typeof updater === "function" ? updater(columnOrder) : updater;
    const order = getPersistedColumnOrder(data);
    updateView.mutate({
      viewId,
      layout: { ...view.layout, columnOrder: order },
    });
  };

  const columnVisibility = useMemo<ColumnVisibilityState>(
    () => createColumnVisibilityState(view.layout.hiddenProperties),
    [view.layout.hiddenProperties],
  );

  const onColumnVisibilityChange: OnChangeFn<ColumnVisibilityState> = (
    updater,
  ) => {
    const data =
      typeof updater === "function" ? updater(columnVisibility) : updater;

    const hiddenProperties = getPersistedHiddenColumnIds(data);

    updateView.mutate({
      viewId,
      layout: { ...view.layout, hiddenProperties },
    });
  };

  const rowSelection = useTableStore(
    (s) => s.rowSelection[viewId] ?? EMPTY_ROW_SELECTION,
  );
  const storeSetRowSelection = useTableStore((s) => s.setRowSelection);

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    storeSetRowSelection(viewId, updater);
  };

  return {
    view,
    contentMode,
    setContentMode: (mode: TableContentMode) => {
      setContentMode(viewId, mode);
    },
    state: {
      columnSizing,
      columnOrder,
      columnPinning,
      columnVisibility,
      sorting,
      rowSelection,
    },
    listeners: {
      onColumnSizingChange,
      onColumnOrderChange,
      onColumnPinningChange,
      onColumnVisibilityChange,
      onSortingChange,
      onRowSelectionChange,
    },
  };
};
