import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";

type UseSyncSelectedEntitiesInput = {
  viewId: string;
  treeData: TableTreeNode[];
};

// Resolves the table's row selection to entity rows for chrome that lives
// outside the table (the view toolbar's bulk actions). Shared by the flat and
// grouped layouts so a grouped view, whose rows are split across sections,
// resolves the same way the flat table does once its sections are unioned.
export const useSyncSelectedEntities = ({
  viewId,
  treeData,
}: UseSyncSelectedEntitiesInput) => {
  const rowSelection = useTableStore((state) => state.rowSelection[viewId]);
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
    setSelectedEntities(viewId, result);
  }, [rowSelection, treeData, viewId, setSelectedEntities]);
};
