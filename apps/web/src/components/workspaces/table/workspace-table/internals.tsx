import type { CSSProperties } from "react";

import { cn } from "@stll/ui/utils";

import {
  WorkspaceGridCell,
  WorkspaceGridFillerCell,
} from "@/components/workspaces/table/workspace-grid";
import type { ColumnDropEdge } from "@/components/workspaces/table/workspace-grid-order";
import {
  getEndFillerGridColumn,
  getWorkspaceGridColumnMetadata,
  isPinnedBoundaryColumn,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import type {
  GridColumnGeometry,
  GridColumnsInput,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import { TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";

export const TABLE_ROW_ESTIMATE_PX = TOOLBAR_ROW_HEIGHT_PX;
export const TABLE_ROW_OVERSCAN = 16;
/**
 * Rows below the window on a table's first paint. Every row mounts a full
 * row of cells, so the scroll buffer (`TABLE_ROW_OVERSCAN`) follows in a
 * background render after that paint instead of delaying it.
 */
export const TABLE_ROW_FIRST_PAINT_OVERSCAN = 2;
export const ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME =
  "[&:has([data-add-property-trigger]:hover)_[data-add-property-surface]]:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] [&:has([data-add-property-trigger]:focus-visible)_[data-add-property-surface]]:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))]";

export type WorkspaceGridStyle = CSSProperties & {
  "--workspace-table-columns": string;
};

export type ColumnDropPosition = {
  sourceId: string;
  targetId: string;
  edge: ColumnDropEdge;
};

export type ExpandedTableCell = {
  rowId: string;
  columnId: string;
};

type PinnedBoundaryProps = {
  column: GridColumnGeometry;
};

export const PinnedBoundary = ({ column }: PinnedBoundaryProps) => {
  if (!isPinnedBoundaryColumn(column)) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className="bg-border pointer-events-none absolute inset-y-0 end-0 z-40 w-px"
    />
  );
};

type RowEndFillerCellProps = GridColumnsInput & {
  actions?: React.ReactNode;
  selected: boolean;
};

export const RowEndFillerCell = ({
  renderColumns,
  addPropertyColumn,
  actions: fallbackActions,
  selected,
}: RowEndFillerCellProps) => {
  const { actionsColumnIndex } = getWorkspaceGridColumnMetadata({
    renderColumns,
    addPropertyColumn,
  });
  const actions =
    actionsColumnIndex === undefined ? undefined : fallbackActions;
  const Cell =
    actions === undefined ? WorkspaceGridFillerCell : WorkspaceGridCell;
  return (
    <Cell
      aria-colindex={actions === undefined ? undefined : actionsColumnIndex}
      aria-hidden={actions === undefined ? true : undefined}
      className={cn(
        "flex items-center justify-end p-0",
        addPropertyColumn && "border-e-0",
      )}
      data-state={selected ? "selected" : undefined}
      style={{
        gridColumn: getEndFillerGridColumn({
          renderColumns,
          addPropertyColumn,
        }),
      }}
    >
      {actions}
    </Cell>
  );
};
