import { useState } from "react";

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
import type { TableColumnLayout } from "@/lib/workspaces/column-layout";
import type { TableContentMode } from "@/lib/workspaces/table-store";
import { useTableStore } from "@/lib/workspaces/table-store";
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
  /** Which columns show, in what order, pinned how — and where that is kept. */
  columnLayout: TableColumnLayout;
};

export const useTableState = ({
  workspaceId,
  view,
  columnLayout,
}: UseTableStateProps) => {
  const viewId = view.id;
  const viewRef = { workspaceId, viewId };
  const updateView = useUpdateView(workspaceId);

  const storedColumnSizing = useTableStore(
    useShallow((s) => {
      const sizing = s.columnSizing[workspaceId]?.[viewId] ?? {};
      return omitUtilityColumnSizing(sizing);
    }),
  );
  const setStoredColumnSizing = useTableStore((s) => s.setColumnSizing);
  const contentMode = useTableStore(
    (s) => s.contentMode[workspaceId]?.[viewId] ?? "tight",
  );
  const setContentMode = useTableStore((s) => s.setContentMode);
  const [columnSizing, setColumnSizing] = useState(storedColumnSizing);

  const debouncedSetStoredColumnSizing = useDebouncedCallback(
    (data: ColumnSizingState) => {
      setStoredColumnSizing(viewRef, data);
    },
    COLUMN_SIZING_DEBOUNCE_MS,
  );

  const onColumnSizingChange: OnChangeFn<ColumnSizingState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnSizing) : updater;
    setColumnSizing(data);
    debouncedSetStoredColumnSizing(data);
  };

  const sorting: SortingState = view.layout.sorts.map((s) => ({
    id: s.propertyId,
    desc: s.desc,
  }));

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

  const rowSelection = useTableStore(
    (s) => s.rowSelection[workspaceId]?.[viewId] ?? EMPTY_ROW_SELECTION,
  );
  const storeSetRowSelection = useTableStore((s) => s.setRowSelection);

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    // The table prunes selections for rows that drop out of the filtered data
    // during render; writing to the (subscribed) store synchronously would
    // update this component mid-render. Defer past the render so the prune
    // lands as its own update — harmless for real clicks (already post-event).
    queueMicrotask(() => storeSetRowSelection(viewRef, updater));
  };

  return {
    view,
    contentMode,
    setContentMode: (mode: TableContentMode) => {
      setContentMode(viewRef, mode);
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
