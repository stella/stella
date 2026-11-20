import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { TableGroupHeaderPending } from "@/components/workspaces/table/group-header.pending";
import type { WorkspaceGridStyle } from "@/components/workspaces/table/workspace-table/internals";
import type { GridColumnsInput } from "@/components/workspaces/table/workspace-table/internals-helpers";
import {
  WorkspaceTableGroupSkeletonHeader,
  WorkspaceTableSkeletonRows,
} from "@/components/workspaces/table/workspace-table/skeleton-rows";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { storedColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";
import {
  getGroupSkeletonLayout,
  pendingGroupedSections,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout.logic";

/**
 * The grouped table's column of sections. `w-max min-w-full` sizes it to
 * the widest section's table, so every section's band runs the whole scroll
 * width; it flows in the view's own scroller (no scroll box of its own).
 */
export const GROUPED_TABLE_CLASS = "flex w-max min-w-full flex-col";

/**
 * A section's placeholder rows in its own grid: the header row with a bar
 * per column, then the skeleton rows. The live section draws it while its
 * count or first page loads, with its ruled filler as `children`.
 */
export const GroupSkeletonFace = ({
  children,
  grid,
  rowCount,
  style,
}: {
  children?: ReactNode;
  grid: GridColumnsInput;
  rowCount: number;
  style: WorkspaceGridStyle;
}) => (
  <div style={style}>
    <WorkspaceTableGroupSkeletonHeader
      addPropertyColumn={grid.addPropertyColumn}
      renderColumns={grid.renderColumns}
    />
    <WorkspaceTableSkeletonRows
      addPropertyColumn={grid.addPropertyColumn}
      renderColumns={grid.renderColumns}
      rowCount={rowCount}
    />
    {children}
  </div>
);

/**
 * A grouped table view before it mounts, as it first draws once mounted:
 * every section the grouping has (an entity kind's or a select property's
 * options, then uncategorized) with its header, its count still a bar, and
 * placeholder rows in the section's own columns. Where the sections are not
 * known from the cached view and properties alone, it claims no shape.
 */
export const GroupedTableViewPending = ({
  properties,
  view,
  workspaceId,
}: {
  properties: readonly WorkspaceProperty[];
  view: WorkspaceView<"table">;
  workspaceId: string;
}) => {
  const sections = pendingGroupedSections({
    properties,
    sizing: storedColumnSizing({ workspaceId, viewId: view.id }),
    view,
  });
  if (sections === null) {
    return null;
  }
  const { skeletonRowCount } = getGroupSkeletonLayout(undefined);
  return (
    <div
      aria-hidden="true"
      className={cn(GROUPED_TABLE_CLASS, "pointer-events-none")}
    >
      {sections.map((section) => (
        <section key={section.key}>
          <TableGroupHeaderPending
            color={section.color}
            label={
              section.label.type === "text" ? (
                section.label.text
              ) : (
                <PendingText barClassName="w-20" id={section.label.id} />
              )
            }
          />
          <GroupSkeletonFace
            grid={section.grid}
            rowCount={skeletonRowCount}
            style={{
              "--workspace-table-columns": section.grid.templateColumns,
              minWidth: section.grid.tableWidth,
            }}
          />
        </section>
      ))}
    </div>
  );
};
