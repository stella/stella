import { useMemo, useState } from "react";

import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  OnChangeFn,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import { useDebouncedCallback } from "use-debounce";
import { useShallow } from "zustand/shallow";

import type { WorkspaceView } from "@/lib/types";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const EMPTY_ROW_SELECTION: RowSelectionState = {};
const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
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
      const {
        [selectColId]: _selectSize,
        [addPropertyColId]: _addPropertySize,
        ...propertySizing
      } = sizing;
      return propertySizing;
    }),
  );
  const setStoredColumnSizing = useTableStore((s) => s.setColumnSizing);
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

  const columnPinning: ColumnPinningState = {
    left: [
      selectColId,
      ...view.layout.columnPinning.filter((id) => id !== addPropertyColId),
    ],
  };

  const onColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnPinning) : updater;
    const pinned = (data.left ?? []).filter(
      (id) => id !== selectColId && id !== addPropertyColId,
    );
    updateView.mutate({
      viewId,
      layout: { ...view.layout, columnPinning: pinned },
    });
  };

  const columnOrder = useMemo<ColumnOrderState>(
    () => [selectColId, ...view.layout.columnOrder],
    [view.layout.columnOrder],
  );

  const onColumnOrderChange: OnChangeFn<ColumnOrderState> = (updater) => {
    const data = typeof updater === "function" ? updater(columnOrder) : updater;
    const order = data.filter(
      (id) => id !== selectColId && id !== addPropertyColId,
    );
    updateView.mutate({
      viewId,
      layout: { ...view.layout, columnOrder: order },
    });
  };

  const columnVisibility = useMemo<VisibilityState>(() => {
    const visibility: Record<string, boolean> = {};

    for (const id of view.layout.hiddenProperties) {
      visibility[id] = false;
    }

    return visibility;
  }, [view.layout.hiddenProperties]);

  const onColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnVisibility) : updater;

    const hiddenProperties = Object.entries(data)
      .filter(([, visible]) => !visible)
      .map(([id]) => id);

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
