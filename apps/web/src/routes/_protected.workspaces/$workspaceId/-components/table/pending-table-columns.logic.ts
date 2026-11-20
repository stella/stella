import type { QueryClient } from "@tanstack/react-query";

import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { getInternalColId } from "@/components/workspaces/internal-ids.logic";
import { layoutPendingGrid } from "@/components/workspaces/table/pending-grid.logic";
import type { PendingTableGrid } from "@/components/workspaces/table/pending-grid.logic";
import { propertiesQueryRoot } from "@/lib/resource-query-roots.logic";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import type { StoredColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";
import { workspaceTableSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/table/entity-table-schema";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";

const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");

/** The schema's labels: a loading table draws bars where its headers go. */
const NO_LABELS = {
  name: "",
  itemType: "",
  status: "",
  priority: "",
  dueDate: "",
  author: "",
  lastUpdated: "",
  version: "",
  documents: "",
};

/** The matter's properties as the cache holds them, or `undefined`. */
export const cachedWorkspaceProperties = (
  queryClient: QueryClient,
  workspaceId: string,
): WorkspaceProperty[] | undefined =>
  newestCachedData(
    queryClient,
    queryClient.getQueriesData<WorkspaceProperty[]>({
      exact: true,
      queryKey: propertiesQueryRoot(workspaceId),
    }),
  );

/**
 * Whether the table view draws grouped sections rather than one flat table,
 * as the table layout decides it: a grouping, unless the view lists items.
 */
export const isGroupedTableView = (view: WorkspaceView<"table">): boolean =>
  view.layout.groupByPropertyId !== undefined &&
  !includesListItems(view.layout.filters);

/**
 * The flat table's columns before its column model exists, laid out the way
 * the loaded table lays them out from the same saved view: the schema's
 * columns at their widths, the view's hidden columns left out, its order
 * applied, the selection column and the view's pinned columns docked at the
 * start, and the add-property column after the filler. A column a reader
 * dragged in this browser takes the width the table store keeps for it,
 * within the column's minimum, as the table's column model takes it.
 */
export const pendingTableGrid = ({
  properties,
  sizing = {},
  view,
}: {
  properties: readonly WorkspaceProperty[];
  /** The widths the table store holds for this view (`storedColumnSizing`). */
  sizing?: StoredColumnSizing | undefined;
  view: WorkspaceView<"table">;
}): PendingTableGrid => {
  const schema = workspaceTableSchema({
    properties,
    view,
    labels: NO_LABELS,
  });
  const isUtility = (id: string) =>
    id === selectColId || id === addPropertyColId;
  // A utility column's width is never kept: the table drops it from the
  // stored widths before it reads them.
  const keptSizing = Object.fromEntries(
    Object.entries(sizing).filter(([id]) => !isUtility(id)),
  );
  return layoutPendingGrid({
    addPropertyColumnId: addPropertyColId,
    columns: schema.columns.map((column) => ({
      id: column.id,
      size: column.size,
      minSize: column.minSize ?? schema.defaultMinSize,
    })),
    hiddenIds: new Set(
      view.layout.hiddenProperties.filter((id) => !isUtility(id)),
    ),
    // The order and pinning states list the selection column, then the
    // saved ones; the columns the order does not name keep the schema's
    // order after those it does.
    orderIds: [
      selectColId,
      ...view.layout.columnOrder.filter((id) => !isUtility(id)),
    ],
    pinnedIds: [
      selectColId,
      ...view.layout.columnPinning.filter((id) => !isUtility(id)),
    ],
    sizing: keptSizing,
  });
};
