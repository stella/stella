import { useMemo, useState } from "react";
import type {
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
import { useViewsActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-views-actor";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const COLUMN_SIZING_DEBOUNCE_MS = 100;

type UseTableStateProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

export const useTableState = ({ workspaceId, view }: UseTableStateProps) => {
  const viewId = view.id;
  const viewsActor = useViewsActor(workspaceId);

  const storedColumnSizing = useTableStore(
    useShallow((s) => s.columnSizing.get(viewId) ?? {}),
  );
  const setStoredColumnSizing = useTableStore((s) => s.setColumnSizing);
  const [columnSizing, setColumnSizing] =
    useState<ColumnSizingState>(storedColumnSizing);

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
    viewsActor.handle?.updateView({
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
    left: [selectColId, ...view.layout.columnPinning],
  };

  const onColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    const data =
      typeof updater === "function" ? updater(columnPinning) : updater;
    viewsActor.handle?.updateView({
      viewId,
      layout: { ...view.layout, columnPinning: data.left ?? [] },
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

    viewsActor.handle?.updateView({
      viewId,
      layout: { ...view.layout, hiddenProperties },
    });
  };

  const rowSelection = useTableStore(
    useShallow((s) => s.rowSelection.get(viewId) ?? {}),
  );
  const storeSetRowSelection = useTableStore((s) => s.setRowSelection);

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    storeSetRowSelection(viewId, updater);
  };

  return {
    view,
    state: {
      columnSizing,
      columnPinning,
      columnVisibility,
      sorting,
      rowSelection,
    },
    listeners: {
      onColumnSizingChange,
      onColumnPinningChange,
      onColumnVisibilityChange,
      onSortingChange,
      onRowSelectionChange,
    },
  };
};
