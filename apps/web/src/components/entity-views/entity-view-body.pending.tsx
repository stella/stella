import type { CSSProperties } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import {
  KANBAN_COLUMN_WIDTH_CLASS,
  KanbanColumnHeaderShell,
  KanbanColumnNameFace,
} from "@stll/ui/kanban-column-header-shell";
import type { KanbanGroup } from "@stll/ui/kanban-grouping";
import { cn } from "@stll/ui/utils";

import {
  entityViewPendingGrid,
  entityViewSizingScope,
} from "@/components/entity-views/columns.logic";
import {
  DEFAULT_ENTITY_VIEW_BOARD_GROUP,
  pendingEntityTableGroups,
  pendingEntityViewGroups,
} from "@/components/entity-views/pending-groups.logic";
import { KanbanCardsPending } from "@/components/workspaces/kanban/kanban-card.pending";
import { TableGroupHeaderPending } from "@/components/workspaces/table/group-header.pending";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import {
  WORKSPACE_TABLE_FRAME_CLASS,
  WORKSPACE_TABLE_GRID_CLASS,
  WORKSPACE_TABLE_SCROLL_CLASS,
} from "@/components/workspaces/table/workspace-grid";
import {
  WorkspaceTableSkeletonHeader,
  WorkspaceTableSkeletonRows,
} from "@/components/workspaces/table/workspace-table/skeleton-rows";
import { storedColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";
import type { InboxLastLayout, InboxLastView } from "@/stores/config-store";

/*
 * The body of an inbox view before its rows: the board's columns or the
 * table's grid, drawn by the inbox's loading view and by the loaded inbox
 * while a board's first page loads (`EntityViews`, ./entity-views.tsx).
 */

const groupKey = (group: KanbanGroup) => group.value ?? "__uncategorized__";

/**
 * The board before its rows: its scroller, the column headers in the board's
 * header row, and placeholder cards under each column. A board that lays its
 * cards out in lanes adds each lane's row above them once the rows say which
 * lanes there are.
 */
const EntityViewKanbanPending = ({
  layout,
}: {
  layout: Extract<InboxLastLayout, { type: "kanban" }>;
}) => {
  const columns = pendingEntityViewGroups(
    layout.groupByPropertyId ?? DEFAULT_ENTITY_VIEW_BOARD_GROUP,
  );
  if (columns === null) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="h-full min-h-0 flex-1 overflow-auto px-4 pb-4"
      data-slot="entity-view-kanban-pending"
    >
      <div className="min-w-max">
        <div className="bg-background sticky top-0 z-20">
          <div className="flex gap-3">
            <div className="flex gap-3">
              {columns.map((group) => (
                <div
                  className={KANBAN_COLUMN_WIDTH_CLASS}
                  key={groupKey(group)}
                >
                  <KanbanColumnHeaderShell
                    name={
                      <KanbanColumnNameFace>
                        <FaceLabelPending className="w-20" />
                        <span className="text-muted-foreground text-xs">
                          <FaceLabelPending className="w-3" />
                        </span>
                      </KanbanColumnNameFace>
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-3 pb-1">
          <div className="flex gap-3">
            {columns.map((group) => (
              <div className={KANBAN_COLUMN_WIDTH_CLASS} key={groupKey(group)}>
                <div className="min-h-24">
                  <KanbanCardsPending />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

type TableGridStyle = CSSProperties & { "--workspace-table-columns": string };

/** Rows a table section stands in while its rows load, as the table draws. */
const PENDING_TABLE_ROWS = 8;

/**
 * The table before its rows: the table itself, its header row and
 * placeholder rows in the grid its saved columns give (their order, pinning
 * and the widths a reader dragged them to). A grouped table draws a section
 * per group, each with its own header row, for a grouping whose groups are
 * fixed; one whose groups come from the rows draws nothing until they do.
 */
const EntityViewTablePending = ({
  layout,
  organizationId,
  viewId,
}: {
  layout: Extract<InboxLastLayout, { type: "table" }>;
  organizationId: string;
  viewId: string;
}) => {
  const grid = entityViewPendingGrid({
    layout,
    sizing: storedColumnSizing({
      workspaceId: entityViewSizingScope(organizationId),
      viewId,
    }),
  });
  const style: TableGridStyle = {
    "--workspace-table-columns": grid.templateColumns,
    minWidth: grid.tableWidth,
    width: `max(${String(grid.tableWidth)}px, 100%)`,
  };
  const groupBy = layout.groupByPropertyId ?? "";
  if (groupBy === "") {
    return (
      <MobileTableOrientationGate>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            aria-hidden="true"
            className={WORKSPACE_TABLE_FRAME_CLASS}
            data-slot="entity-view-table-pending"
          >
            <div className={WORKSPACE_TABLE_SCROLL_CLASS}>
              <div
                className={cn(WORKSPACE_TABLE_GRID_CLASS, "min-h-full")}
                style={style}
              >
                <div className="bg-background sticky top-0 z-30">
                  <WorkspaceTableSkeletonHeader
                    renderColumns={grid.renderColumns}
                  />
                </div>
                <div className="flex flex-1 flex-col">
                  <WorkspaceTableSkeletonRows
                    renderColumns={grid.renderColumns}
                    rowCount={PENDING_TABLE_ROWS}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </MobileTableOrientationGate>
    );
  }
  return (
    <MobileTableOrientationGate>
      <div
        aria-hidden="true"
        className="min-h-0 flex-1 overflow-auto"
        data-slot="entity-view-table-pending"
      >
        {pendingEntityTableGroups(groupBy).map((group) => (
          <section key={groupKey(group)}>
            <TableGroupHeaderPending
              color={group.color}
              label={<FaceLabelPending className="w-20" />}
            />
            <div className="relative">
              <div className="w-full">
                <div className={WORKSPACE_TABLE_GRID_CLASS} style={style}>
                  <div className="bg-background z-30">
                    <WorkspaceTableSkeletonHeader
                      renderColumns={grid.renderColumns}
                    />
                  </div>
                  <div className="flex flex-1 flex-col">
                    <WorkspaceTableSkeletonRows
                      renderColumns={grid.renderColumns}
                      rowCount={PENDING_TABLE_ROWS}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </MobileTableOrientationGate>
  );
};

/**
 * The active view's body before its rows: the board or the table that view
 * lays out, from what of its layout the body's shape depends on.
 */
export const EntityViewBodyPending = ({
  lastView,
}: {
  lastView: InboxLastView;
}) =>
  lastView.layout.type === "kanban" ? (
    <EntityViewKanbanPending layout={lastView.layout} />
  ) : (
    <EntityViewTablePending
      layout={lastView.layout}
      organizationId={lastView.organizationId}
      viewId={lastView.viewId}
    />
  );
