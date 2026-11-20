/**
 * The loading rows of a workspace table.
 *
 * They are drawn from the table's own column model, in the table's own grid,
 * so a waiting table is the table: every column shimmers at the width it will
 * have, and adding, hiding or reordering a column moves its placeholder with
 * it. One implementation serves the matter table and the results table, so
 * neither can grow a loading state the other does not have.
 */

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import {
  WorkspaceGridCell,
  WorkspaceGridHead,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import {
  PinnedBoundary,
  RowEndFillerCell,
} from "@/components/workspaces/table/workspace-table/internals";
import {
  getEndFillerGridColumn,
  getGridPinningStyles,
  isPinnedBoundaryColumn,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import type { GridColumnGeometry } from "@/components/workspaces/table/workspace-table/internals-helpers";
import { SKELETON_ROW_KEYS } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";

type WorkspaceTableSkeletonRowsProps = {
  addPropertyColumn?: GridColumnGeometry | null;
  renderColumns: readonly GridColumnGeometry[];
  /** Rows to draw; clamped to the keys the module reserves. */
  rowCount: number;
};

export const WorkspaceTableSkeletonRows = ({
  addPropertyColumn = null,
  renderColumns,
  rowCount,
}: WorkspaceTableSkeletonRowsProps) =>
  SKELETON_ROW_KEYS.slice(0, Math.min(rowCount, SKELETON_ROW_KEYS.length)).map(
    (rowKey) => (
      <WorkspaceGridRow
        aria-hidden="true"
        className="pointer-events-none"
        key={rowKey}
        role="presentation"
      >
        {renderColumns.map((column, index) => (
          <WorkspaceGridCell
            className={cn(
              "flex items-center",
              isPinnedBoundaryColumn(column) && "border-e-0",
            )}
            key={column.id}
            role="presentation"
            style={{
              gridColumn: index + 1,
              ...getGridPinningStyles(column),
            }}
          >
            <PinnedBoundary column={column} />
            <Skeleton className="h-3.5 w-3/5" />
          </WorkspaceGridCell>
        ))}
        <RowEndFillerCell
          addPropertyColumn={addPropertyColumn}
          renderColumns={renderColumns}
          selected={false}
        />
        {addPropertyColumn && (
          <WorkspaceGridCell
            className="border-s-2 border-e-2 p-0"
            data-add-property-surface
            role="presentation"
            style={getGridPinningStyles(addPropertyColumn)}
          />
        )}
      </WorkspaceGridRow>
    ),
  );

type WorkspaceTableSkeletonHeaderProps = {
  addPropertyColumn?: GridColumnGeometry | null;
  renderColumns: readonly GridColumnGeometry[];
};

/**
 * The header row of a table drawn before its column model exists: each
 * column's head at its width and pinning, with a bar where its name goes,
 * then the filler and the add-property head, as the loaded header lays them
 * out. For a loading view that knows the columns from the saved view.
 */
export const WorkspaceTableSkeletonHeader = ({
  addPropertyColumn = null,
  renderColumns,
}: WorkspaceTableSkeletonHeaderProps) => (
  <WorkspaceGridRow aria-hidden="true" role="presentation">
    {renderColumns.map((column, index) => (
      <WorkspaceGridHead
        className={cn(
          "relative",
          isPinnedBoundaryColumn(column) && "border-e-0",
        )}
        key={column.id}
        role="presentation"
        style={{
          gridColumn: index + 1,
          ...getGridPinningStyles(column),
        }}
      >
        <PinnedBoundary column={column} />
        <span className="flex items-center px-2">
          <Skeleton className="h-3 w-3/5" />
        </span>
      </WorkspaceGridHead>
    ))}
    <WorkspaceGridHead
      className={cn("pointer-events-none", addPropertyColumn && "border-e-0")}
      role="presentation"
      style={{
        gridColumn: getEndFillerGridColumn({
          renderColumns,
          addPropertyColumn,
        }),
      }}
    />
    {addPropertyColumn && (
      <WorkspaceGridHead
        className="relative border-s-2 border-e-2"
        data-add-property-surface
        role="presentation"
        style={getGridPinningStyles(addPropertyColumn)}
      />
    )}
  </WorkspaceGridRow>
);
