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
 * the readers that send it. It reads the committed term rather than the draft,
 * so the rows and their highlights change together.
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

  const term = find?.term.trim() ?? "";
  if (!find || term === "") {
    return { columns, highlight: null, request: {} };
  }

  const findScope = resolveFindScope({ columns, selection: find.scope });
  return {
    columns,
    highlight: {
      matchesName: findScope.type === "all",
      propertyIds: new Set(findScope.propertyIds),
      term,
    },
    request: { find: term, findScope },
  };
};
