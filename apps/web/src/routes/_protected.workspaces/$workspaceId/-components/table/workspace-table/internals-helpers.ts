import type { CSSProperties } from "react";

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { panic } from "better-result";

import { TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";
import type {
  TableColumn,
  TableHeader,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { getGridTemplateColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import type { ColumnDropEdge } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const selectColId = getInternalColId("select");
export const addPropertyColId = getInternalColId("add-property");
export const TABLE_COLUMN_DRAG_TYPE = "workspace-table-column";

const TABLE_END_FILLER_LINE =
  "color-mix(in srgb, var(--color-border) 60%, transparent)";
const TABLE_END_FILLER_BACKGROUND = `repeating-linear-gradient(
  to bottom,
  transparent 0,
  transparent ${TOOLBAR_ROW_HEIGHT_PX - 1}px,
  ${TABLE_END_FILLER_LINE} ${TOOLBAR_ROW_HEIGHT_PX - 1}px,
  ${TABLE_END_FILLER_LINE} ${TOOLBAR_ROW_HEIGHT_PX}px
)`;

export const tableEndFillerCellStyle: CSSProperties = {
  backgroundImage: TABLE_END_FILLER_BACKGROUND,
};

export type EndFillerInput = {
  renderColumns: TableColumn[];
  addPropertyColumn: TableColumn | null;
};

export type ColumnDragPinning = "start" | "end" | "center";

export type ColumnDragData = {
  type: typeof TABLE_COLUMN_DRAG_TYPE;
  columnId: string;
  pinning: ColumnDragPinning;
};

export const getVerticalScrollbarWidth = (element: HTMLElement) =>
  Math.max(0, element.offsetWidth - element.clientWidth);

// Nearest scrollable ancestor of an element, used as an IntersectionObserver
// root so observers report against the real scroll viewport (the grouped table
// flows inside an ancestor `overflow-auto`, not its own scroll box). `null`
// falls back to the browser viewport.
export const getScrollableAncestor = (
  element: HTMLElement,
): HTMLElement | null => {
  let current = element.parentElement;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
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

export const getGridPinningStyles = (column: TableColumn): CSSProperties => {
  if (column.id === addPropertyColId) {
    return {
      gridColumn: "-2 / -1",
      position: "sticky",
      insetInlineEnd: 0,
      zIndex: 2,
    };
  }
  const isStartPinned = column.getIsPinned() === "start";
  if (!isStartPinned) {
    return {};
  }

  // Stella only pins to "start"; `getStart("start")` is the cumulative
  // inline offset of the pinned columns. Resolve it to `inset-inline-start`
  // so the frozen column docks to the start edge under both LTR and RTL.
  return {
    insetInlineStart: `${column.getStart("start")}px`,
    position: "sticky",
    zIndex: column.id === selectColId ? 21 : 20,
  };
};

export const isPinnedBoundaryColumn = (column: TableColumn) =>
  column.getIsPinned() === "start" && column.getIsLastColumn("start");

export const getColumnPinningGroup = (
  column: TableColumn,
): ColumnDragPinning => {
  const pinning = column.getIsPinned();
  if (pinning === "start" || pinning === "end") {
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
    (pinning === "start" || pinning === "end" || pinning === "center")
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

export const getOrderedHeaders = (
  headers: TableHeader[],
  columns: TableColumn[],
) => {
  const headersByColumnId = new Map(
    headers.map((header) => [header.column.id, header]),
  );
  const orderedHeaders: TableHeader[] = [];

  for (const column of columns) {
    const header = headersByColumnId.get(column.id);
    if (header) {
      orderedHeaders.push(header);
    }
  }

  return orderedHeaders;
};

export const getRequiredHeader = (headers: TableHeader[], columnId: string) => {
  const header = headers.find((candidate) => candidate.column.id === columnId);
  if (!header) {
    panic(`Missing header for workspace table column "${columnId}"`);
  }

  return header;
};
