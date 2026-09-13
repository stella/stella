/**
 * The matter table's rows.
 *
 * Everything the table shell used to know about entities lives here: what a
 * row draws, what an inline rename commits to, which row the inspector is
 * showing, how many rows a collapsed folder stands for, which selections
 * survive a select-all across groups, and the two controls only a matter has
 * (the add-column rail and the add-row under the last row). The shell keeps
 * the grid.
 */

import { useState } from "react";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import { countDescendants } from "@/components/workspaces/entity-utils";
import type { TableRowHost } from "@/components/workspaces/table/row-host";
import type {
  TableTreeNode,
  WorkspaceTable,
} from "@/components/workspaces/table/types";
import { useRenameEntity } from "@/lib/workspaces/mutations/entities";
import { useTableStore } from "@/lib/workspaces/table-store";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { DraggableRow } from "@/routes/_protected.workspaces/$workspaceId/-components/table/entity-row-cells";

type EntityRowHostInput = {
  workspaceId: string;
  table: WorkspaceTable;
  /**
   * A grouped section's view id, so "select all" can read the cross-group
   * row-id union at click time and keep selections in the other sections
   * (they share one selection) while still dropping stale ids. Omitted by the
   * flat table, whose selectable rows already cover every row.
   */
  viewId?: string | undefined;
  /**
   * Whether this table offers the "+ new document" row. Grouped sections opt
   * out so it isn't repeated under every group.
   */
  addRow: boolean;
};

/**
 * The rows a collapsed folder stands for. Module-level, so the shell's row
 * labels memo keeps one identity across renders.
 */
const folderDescendantCount = (row: TableTreeNode): number =>
  row.kind === "folder" ? countDescendants(row) : 0;

export const useEntityRowHost = ({
  workspaceId,
  table,
  viewId,
  addRow,
}: EntityRowHostInput): TableRowHost => {
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const renameEntity = useRenameEntity();

  const activeEntityId = useInspectorTabsStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "pdf" ? tab.entityId : null;
  });
  const activePropertyId = useInspectorTabsStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "pdf" ? (tab.propertyId ?? null) : null;
  });
  const activeTaskId = useInspectorTabsStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "task" ? tab.id : null;
  });

  return {
    renderRow: (input) => (
      <DraggableRow
        {...input}
        activeEntityId={activeEntityId}
        activePropertyId={activePropertyId}
        activeTaskId={activeTaskId}
        editingEntityId={editingEntityId}
        onRename={(entityId, name) => {
          renameEntity.mutate({ workspaceId, entityId, name });
        }}
        onStartEditing={setEditingEntityId}
        onStopEditing={() => setEditingEntityId(null)}
        workspaceId={workspaceId}
      />
    ),
    collapsedRowSpan: folderDescendantCount,
    addColumnRail: (
      <BulkAddColumns
        target={{ kind: "workspace", workspaceId }}
        triggerVariant="rail"
      />
    ),
    ...(viewId === undefined
      ? {}
      : {
          // Read at click time, never subscribed, so the table does not
          // re-render as the union grows during load.
          preservableRowIds: () =>
            useTableStore.getState().preservableRowIds[workspaceId]?.[viewId],
        }),
    ...(addRow
      ? {
          bottomRow: (
            <BottomRow
              onFolderCreated={setEditingEntityId}
              table={table}
              workspaceId={workspaceId}
            />
          ),
        }
      : {}),
  };
};
