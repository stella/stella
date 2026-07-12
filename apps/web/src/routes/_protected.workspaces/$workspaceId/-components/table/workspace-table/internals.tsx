import type { CSSProperties } from "react";

import { TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";
import type { TableColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import type { ColumnDropEdge } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import { isPinnedBoundaryColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals-helpers";

export const TABLE_ROW_ESTIMATE_PX = TOOLBAR_ROW_HEIGHT_PX;
export const TABLE_ROW_OVERSCAN = 16;
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
  entityId: string;
  columnId: string;
};

type PinnedBoundaryProps = {
  column: TableColumn;
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
