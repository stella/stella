import type { CSSProperties } from "react";

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Column } from "@tanstack/react-table";

import { TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { getGridTemplateColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import type { ColumnDropEdge } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const selectColId = getInternalColId("select");
export const addPropertyColId = getInternalColId("add-property");
export const TABLE_ROW_ESTIMATE_PX = TOOLBAR_ROW_HEIGHT_PX;
export const TABLE_ROW_OVERSCAN = 16;
export const TABLE_COLUMN_DRAG_TYPE = "workspace-table-column";
const TABLE_END_FILLER_LINE =
  "color-mix(in srgb, var(--color-border) 60%, transparent)";
const TABLE_END_FILLER_BACKGROUND = `repeating-linear-gradient(
  to bottom,
  transparent 0,
  transparent ${TABLE_ROW_ESTIMATE_PX - 1}px,
  ${TABLE_END_FILLER_LINE} ${TABLE_ROW_ESTIMATE_PX - 1}px,
  ${TABLE_END_FILLER_LINE} ${TABLE_ROW_ESTIMATE_PX}px
)`;
export const ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME =
  "[&:has([data-add-property-trigger]:hover)_[data-add-property-surface]]:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] [&:has([data-add-property-trigger]:focus-visible)_[data-add-property-surface]]:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))]";

export type WorkspaceGridStyle = CSSProperties & {
  "--workspace-table-columns": string;
};

export type EndFillerInput = {
  renderColumns: Column<TableTreeNode>[];
  addPropertyColumn: Column<TableTreeNode> | null;
};

export const tableEndFillerCellStyle: CSSProperties = {
  backgroundImage: TABLE_END_FILLER_BACKGROUND,
};

export const getVerticalScrollbarWidth = (element: HTMLElement) =>
  Math.max(0, element.offsetWidth - element.clientWidth);

export type ColumnDragPinning = "left" | "right" | "center";

export type ColumnDragData = {
  type: typeof TABLE_COLUMN_DRAG_TYPE;
  columnId: string;
  pinning: ColumnDragPinning;
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

export function getWorkspaceGridTemplateColumns({
  renderColumns,
  addPropertyColumn,
}: EndFillerInput) {
  const contentColumns = getGridTemplateColumns(renderColumns);
  if (addPropertyColumn) {
    return `${contentColumns} minmax(0, 1fr) ${addPropertyColumn.getSize()}px`;
  }

  return `${contentColumns} minmax(0, 1fr)`;
}

export function getEndFillerGridColumn({
  renderColumns,
  addPropertyColumn,
}: EndFillerInput) {
  return `${renderColumns.length + 1} / ${addPropertyColumn ? "-2" : "-1"}`;
}

export const getGridPinningStyles = (
  column: Column<TableTreeNode>,
): CSSProperties => {
  if (column.id === addPropertyColId) {
    return {
      gridColumn: "-2 / -1",
      position: "sticky",
      right: 0,
      zIndex: 2,
    };
  }
  const isLeftPinned = column.getIsPinned() === "left";
  if (!isLeftPinned) {
    return {};
  }

  return {
    left: `${column.getStart("left")}px`,
    position: "sticky",
    zIndex: column.id === selectColId ? 21 : 20,
  };
};

type PinnedBoundaryProps = {
  column: Column<TableTreeNode>;
};

export const isPinnedBoundaryColumn = (column: Column<TableTreeNode>) =>
  column.getIsPinned() === "left" && column.getIsLastColumn("left");

export const PinnedBoundary = ({ column }: PinnedBoundaryProps) => {
  if (!isPinnedBoundaryColumn(column)) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className="bg-border pointer-events-none absolute inset-y-0 right-0 z-40 w-px"
    />
  );
};

export const getColumnPinningGroup = (
  column: Column<TableTreeNode>,
): ColumnDragPinning => {
  const pinning = column.getIsPinned();
  if (pinning === "left" || pinning === "right") {
    return pinning;
  }

  return "center";
};

export const getColumnDragData = (
  data: Record<string | symbol, unknown>,
): ColumnDragData | null => {
  const type = data["type"];
  const columnId = data["columnId"];
  const pinning = data["pinning"];

  if (
    type === TABLE_COLUMN_DRAG_TYPE &&
    typeof columnId === "string" &&
    (pinning === "left" || pinning === "right" || pinning === "center")
  ) {
    return { type, columnId, pinning };
  }

  return null;
};

export const toColumnDropEdge = (edge: Edge | null): ColumnDropEdge | null => {
  if (edge === "left" || edge === "right") {
    return edge;
  }

  return null;
};
