import type { CSSProperties } from "react";

import type { QueryClient } from "@tanstack/react-query";

import { cn } from "@stll/ui/utils";

import {
  WORKSPACE_TABLE_FRAME_CLASS,
  WORKSPACE_TABLE_GRID_CLASS,
  WORKSPACE_TABLE_SCROLL_CLASS,
} from "@/components/workspaces/table/workspace-grid";
import {
  WorkspaceTableSkeletonHeader,
  WorkspaceTableSkeletonRows,
} from "@/components/workspaces/table/workspace-table/skeleton-rows";
import { tableSkeletonRowCount } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";
import type { WorkspaceView } from "@/lib/types";
import { storedColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";
import { GroupedTableViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout.pending";
import {
  cachedWorkspaceProperties,
  isGroupedTableView,
  pendingTableGrid,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/pending-table-columns.logic";

type TableGridStyle = CSSProperties & { "--workspace-table-columns": string };

/** Rows a table stands in while its first window loads: about a screen. */
const PENDING_TABLE_ROWS = 12;

/**
 * A table view before it mounts: the table itself, its header row and
 * placeholder rows in the grid its saved layout gives (the columns, their
 * order, widths and pinning, and the widths a reader dragged them to), from
 * the cached view, the matter's cached properties and the table store.
 * Without the properties there are no columns to lay out; a grouped table
 * draws its sections from the same properties.
 */
export const TableViewPending = ({
  cache,
  view,
  workspaceId,
}: {
  cache: QueryClient | null;
  view: WorkspaceView<"table">;
  workspaceId: string;
}) => {
  const properties =
    cache === null ? undefined : cachedWorkspaceProperties(cache, workspaceId);
  if (properties === undefined) {
    return null;
  }
  if (isGroupedTableView(view)) {
    return (
      <GroupedTableViewPending
        properties={properties}
        view={view}
        workspaceId={workspaceId}
      />
    );
  }
  const grid = pendingTableGrid({
    properties,
    sizing: storedColumnSizing({ workspaceId, viewId: view.id }),
    view,
  });
  const style: TableGridStyle = {
    "--workspace-table-columns": grid.templateColumns,
    minWidth: grid.tableWidth,
    width: `max(${String(grid.tableWidth)}px, 100%)`,
  };
  return (
    <div aria-hidden="true" className={WORKSPACE_TABLE_FRAME_CLASS}>
      <div className={WORKSPACE_TABLE_SCROLL_CLASS}>
        <div
          className={cn(WORKSPACE_TABLE_GRID_CLASS, "min-h-full")}
          style={style}
        >
          <div className="bg-background z-30">
            <WorkspaceTableSkeletonHeader
              addPropertyColumn={grid.addPropertyColumn}
              renderColumns={grid.renderColumns}
            />
          </div>
          <div className="flex flex-1 flex-col">
            <WorkspaceTableSkeletonRows
              addPropertyColumn={grid.addPropertyColumn}
              renderColumns={grid.renderColumns}
              rowCount={tableSkeletonRowCount(PENDING_TABLE_ROWS)}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
