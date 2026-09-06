import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import type { EntitiesFindKey } from "@/lib/workspaces/queries/entities.logic";
import { useWorkspaceTableSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import {
  resolveFindScope,
  toFindColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { TableFindColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";

type TableFindResult = {
  columns: TableFindColumn[];
  highlight: TableFindHighlight | null;
  request: EntitiesFindKey;
};

/**
 * One resolution of a view's find bar, read by the toolbar that edits it and by
 * the readers that send it. It reads `submitted`, never `typed`, so a row query
 * and the marks drawn over its answer always describe the same term.
 */
export const useTableFind = ({
  properties,
  view,
}: {
  properties: WorkspaceProperty[];
  view: WorkspaceView<"table">;
}): TableFindResult => {
  const schema = useWorkspaceTableSchema({ properties, view });
  const find = useTableStore((state) => state.find[view.id]);
  const columns = toFindColumns({
    columns: schema.columns,
    hiddenProperties: view.layout.hiddenProperties,
  });

  const term = find?.submitted.trim() ?? "";
  if (!find || term === "") {
    return { columns, highlight: null, request: {} };
  }

  const scope = resolveFindScope({ columns, selection: find.scope });
  return {
    columns,
    highlight: {
      matchesName: scope.type === "all",
      propertyIds: new Set(scope.propertyIds),
      term,
    },
    request: { find: { scope, term } },
  };
};
