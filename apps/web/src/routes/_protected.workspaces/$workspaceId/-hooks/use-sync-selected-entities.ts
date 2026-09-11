import type { TableTreeNode } from "@/components/workspaces/table/types";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useTableStore } from "@/lib/workspaces/table-store";
import { getViewRecord } from "@/lib/workspaces/table-store.logic";

type UseSyncSelectedEntitiesInput = {
  workspaceId: string;
  viewId: string;
  treeData: TableTreeNode[];
};

// Resolves the table's row selection to entity rows for chrome that lives
// outside the table (the view toolbar's bulk actions). Shared by the flat and
// grouped layouts so a grouped view, whose rows are split across sections,
// resolves the same way the flat table does once its sections are unioned.
export const useSyncSelectedEntities = ({
  workspaceId,
  viewId,
  treeData,
}: UseSyncSelectedEntitiesInput) => {
  const rowSelection = useTableStore((state) =>
    getViewRecord(state.rowSelection, { workspaceId, viewId }),
  );
  const setSelectedEntities = useTableStore(
    (state) => state.setSelectedEntities,
  );

  useExternalSyncEffect(() => {
    const selected = rowSelection ?? {};
    const result: TableTreeNode[] = [];
    const visit = (nodes: TableTreeNode[] | undefined) => {
      if (!nodes) {
        return;
      }

      for (const node of nodes) {
        if (selected[node.entityId]) {
          result.push(node);
        }
        visit(node.children);
      }
    };
    visit(treeData);
    setSelectedEntities({ workspaceId, viewId }, result);
  }, [rowSelection, treeData, workspaceId, viewId, setSelectedEntities]);
};
