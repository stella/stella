/**
 * A matter table's controlled state: the shared table state, with the four
 * things a matter keeps read from where a matter keeps them — the saved view
 * for the arrangement and the sorts, the per-view table store for widths and
 * the selection.
 */

import { useShallow } from "zustand/shallow";

import { useTableState } from "@/components/workspaces/table/use-table-state";
import type { TableColumnSizingLayout } from "@/components/workspaces/table/use-table-state";
import { omitUtilityColumnSizing } from "@/components/workspaces/table/use-table-state.logic";
import type { WorkspaceView } from "@/lib/types";
import type { TableColumnLayout } from "@/lib/workspaces/column-layout";
import { useUpdateView } from "@/lib/workspaces/mutations/views";
import type { TableContentMode } from "@/lib/workspaces/table-store";
import { useTableStore } from "@/lib/workspaces/table-store";

const EMPTY_ROW_SELECTION = {};

type UseViewTableStateProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
  /** Which columns show, in what order, pinned how — and where that is kept. */
  columnLayout: TableColumnLayout;
};

export const useViewTableState = ({
  workspaceId,
  view,
  columnLayout,
}: UseViewTableStateProps) => {
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
  const rowSelection = useTableStore(
    (s) => s.rowSelection[workspaceId]?.[viewId] ?? EMPTY_ROW_SELECTION,
  );
  const storeSetRowSelection = useTableStore((s) => s.setRowSelection);

  const columnSizing: TableColumnSizingLayout = {
    sizing: storedColumnSizing,
    onChange: (sizing) => {
      setStoredColumnSizing(viewRef, sizing);
    },
  };

  const tableState = useTableState({
    columnLayout,
    columnSizing,
    rowSelection: {
      selection: rowSelection,
      onChange: (updater) => {
        // The table prunes selections for rows that drop out of the filtered
        // data during render; writing to the (subscribed) store synchronously
        // would update this component mid-render. Defer past the render so the
        // prune lands as its own update — harmless for real clicks (already
        // post-event).
        queueMicrotask(() => storeSetRowSelection(viewRef, updater));
      },
    },
    sorting: {
      sorts: view.layout.sorts.map((s) => ({ id: s.propertyId, desc: s.desc })),
      onChange: (sorts) => {
        updateView.mutate({
          viewId,
          layout: {
            ...view.layout,
            sorts: sorts.map((s) => ({ propertyId: s.id, desc: s.desc })),
          },
        });
      },
    },
  });

  return {
    view,
    contentMode,
    setContentMode: (mode: TableContentMode) => {
      setContentMode(viewRef, mode);
    },
    state: tableState.state,
    listeners: tableState.listeners,
  };
};
