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

import type {
  TableColumn,
  TableRowData,
} from "@/components/workspaces/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import { RowEndFillerCell } from "@/components/workspaces/table/workspace-table/end-fillers";
import { PinnedBoundary } from "@/components/workspaces/table/workspace-table/internals";
import {
  getGridPinningStyles,
  isPinnedBoundaryColumn,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import { SKELETON_ROW_KEYS } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";

type WorkspaceTableSkeletonRowsProps<TRow extends TableRowData> = {
  addPropertyColumn?: TableColumn<TRow> | null;
  renderColumns: TableColumn<TRow>[];
  /** Rows to draw; clamped to the keys the module reserves. */
  rowCount: number;
};

export const WorkspaceTableSkeletonRows = <TRow extends TableRowData>({
  addPropertyColumn = null,
  renderColumns,
  rowCount,
}: WorkspaceTableSkeletonRowsProps<TRow>) =>
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
