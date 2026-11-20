import type { QueryClient } from "@tanstack/react-query";

import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { getInternalColId } from "@/components/workspaces/internal-ids.logic";
import { getWorkspaceGridTemplateColumns } from "@/components/workspaces/table/workspace-table/internals-helpers";
import type {
  GridColumnGeometry,
  GridColumnsInput,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
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

type PendingColumn = { id: string; size: number };

/** A column's geometry from its place in the layout, as the grid reads it. */
const geometry = (
  column: PendingColumn,
  pinned: boolean,
  start: number,
  isLastPinned: boolean,
): GridColumnGeometry => ({
  id: column.id,
  getSize: () => column.size,
  getIsPinned: () => (pinned ? "start" : false),
  getStart: () => start,
  getIsLastColumn: () => isLastPinned,
});

export type PendingTableGrid = GridColumnsInput & {
  /** `--workspace-table-columns`, as the loaded table sets it. */
  templateColumns: string;
  /** The columns' total width, below which the grid scrolls sideways. */
  tableWidth: number;
};

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
  const hidden = new Set<string>(
    view.layout.hiddenProperties.filter((id) => !isUtility(id)),
  );
  // A utility column's width is never kept: the table drops it from the
  // stored widths before it reads them.
  const columns = schema.columns.map((column) => {
    const stored = isUtility(column.id) ? undefined : sizing[column.id];
    return {
      id: column.id,
      size: Math.max(
        stored ?? column.size,
        column.minSize ?? schema.defaultMinSize,
      ),
    };
  });
  const visible = columns.filter((column) => !hidden.has(column.id));
  const byId = new Map(visible.map((column) => [column.id, column]));

  // The order state lists the selection column, then the saved order; the
  // columns it does not name keep the schema's order after those it does.
  const orderIds: string[] = [
    selectColId,
    ...view.layout.columnOrder.filter((id) => !isUtility(id)),
  ];
  const named = orderIds.flatMap((id) => {
    const column = byId.get(id);
    return column === undefined ? [] : [column];
  });
  const namedIds = new Set(named.map((column) => column.id));
  const ordered = [
    ...named,
    ...visible.filter((column) => !namedIds.has(column.id)),
  ];

  const pinnedIds: string[] = [
    selectColId,
    ...view.layout.columnPinning.filter((id) => !isUtility(id)),
  ];
  const pinned = pinnedIds.flatMap((id) => {
    const column = byId.get(id);
    return column === undefined ? [] : [column];
  });
  const pinnedSet = new Set(pinned.map((column) => column.id));
  const center = ordered.filter((column) => !pinnedSet.has(column.id));

  let offset = 0;
  const startColumns = pinned.map((column, index) => {
    const placed = geometry(column, true, offset, index === pinned.length - 1);
    offset += column.size;
    return placed;
  });
  const centerColumns = center.map((column) =>
    geometry(column, false, 0, false),
  );
  const all = [...startColumns, ...centerColumns];
  const renderColumns = all.filter((column) => column.id !== addPropertyColId);
  const addPropertyColumn =
    all.find((column) => column.id === addPropertyColId) ?? null;
  return {
    renderColumns,
    addPropertyColumn,
    templateColumns: getWorkspaceGridTemplateColumns({
      renderColumns,
      addPropertyColumn,
    }),
    tableWidth: all.reduce((sum, column) => sum + column.getSize(), 0),
  };
};
