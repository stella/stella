import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { flexRender } from "@tanstack/react-table";
import type { Column } from "@tanstack/react-table";
import { CheckIcon, GripVerticalIcon, MinusIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

import type { SelectAllState } from "@/routes/_protected.workspaces/$workspaceId/-components/table/select-all.logic";
import type {
  TableHeader,
  TableTreeNode,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { WorkspaceGridHead } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import type { ColumnDropEdge } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import {
  addPropertyColId,
  getColumnDragData,
  getColumnPinningGroup,
  getEndFillerGridColumn,
  getGridPinningStyles,
  isPinnedBoundaryColumn,
  PinnedBoundary,
  selectColId,
  TABLE_COLUMN_DRAG_TYPE,
  toColumnDropEdge,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import type {
  ColumnDragData,
  EndFillerInput,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";

type DraggableHeaderCellProps = {
  header: TableHeader;
  index: number;
  collapseEndBorder?: boolean;
  expandedColumnId: string | null;
  onToggleSelectAll: () => void;
  selectAllState: SelectAllState;
};

export const DraggableHeaderCell = ({
  header,
  index,
  collapseEndBorder = false,
  expandedColumnId,
  onToggleSelectAll,
  selectAllState,
}: DraggableHeaderCellProps) => {
  const headerRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [closestEdge, setClosestEdge] = useState<ColumnDropEdge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const canReorderColumn =
    !header.isPlaceholder &&
    header.column.id !== selectColId &&
    header.column.id !== addPropertyColId;
  const isAddPropertyColumn = header.column.id === addPropertyColId;
  const pinning = getColumnPinningGroup(header.column);

  useEffect(() => {
    const element = headerRef.current;
    const dragHandle = dragHandleRef.current;
    if (!element) {
      return undefined;
    }

    const cleanups = [
      dropTargetForElements({
        element,
        canDrop: ({ source }) => {
          const dragData = getColumnDragData(source.data);
          return Boolean(
            canReorderColumn &&
            dragData &&
            dragData.columnId !== header.column.id &&
            dragData.pinning === pinning,
          );
        },
        getData: ({ input, element: targetElement }) =>
          attachClosestEdge(
            {
              columnId: header.column.id,
              pinning,
            },
            {
              input,
              element: targetElement,
              allowedEdges: ["left", "right"],
            },
          ),
        onDragEnter: ({ self, source }) => {
          const dragData = getColumnDragData(source.data);
          if (!dragData || dragData.columnId === header.column.id) {
            return;
          }
          setClosestEdge(toColumnDropEdge(extractClosestEdge(self.data)));
        },
        onDrag: ({ self, source }) => {
          const dragData = getColumnDragData(source.data);
          if (!dragData || dragData.columnId === header.column.id) {
            return;
          }
          const nextEdge = toColumnDropEdge(extractClosestEdge(self.data));
          setClosestEdge((prev) => (prev === nextEdge ? prev : nextEdge));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      }),
    ];

    if (canReorderColumn && dragHandle) {
      cleanups.push(
        draggable({
          element,
          dragHandle,
          getInitialData: (): ColumnDragData => ({
            type: TABLE_COLUMN_DRAG_TYPE,
            columnId: header.column.id,
            pinning,
          }),
          onDragStart: () => setIsDragging(true),
          onDrop: () => setIsDragging(false),
        }),
      );
    }

    return combine(...cleanups);
  }, [canReorderColumn, header.column, pinning]);

  let headerContent: ReactNode = null;
  if (header.column.id === selectColId) {
    headerContent = (
      <SelectAllHeader onToggle={onToggleSelectAll} state={selectAllState} />
    );
  } else if (!header.isPlaceholder) {
    headerContent = flexRender(
      header.column.columnDef.header,
      header.getContext(),
    );
  }

  return (
    <WorkspaceGridHead
      aria-colindex={index + 1}
      className={cn(
        "relative",
        isAddPropertyColumn && "border-s-2 border-e-2",
        isAddPropertyColumn && "transition-colors",
        isAddPropertyColumn && "hover:bg-transparent",
        isPinnedBoundaryColumn(header.column) && "border-e-0",
        collapseEndBorder && "border-e-0",
        expandedColumnId !== null &&
          expandedColumnId !== header.column.id &&
          "opacity-80 transition-opacity duration-150 hover:opacity-95",
        isDragging && "opacity-50",
        closestEdge && "overflow-visible",
        header.column.getIsResizing() &&
          "after:bg-info after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-50 after:w-px",
      )}
      data-add-property-surface={isAddPropertyColumn ? true : undefined}
      ref={headerRef}
      style={{
        gridColumn: isAddPropertyColumn ? undefined : index + 1,
        ...getGridPinningStyles(header.column),
      }}
    >
      <PinnedBoundary column={header.column} />
      {closestEdge && !isDragging && (
        <span
          className={cn(
            "bg-primary pointer-events-none absolute inset-y-1 z-50 w-0.5 rounded-full",
            closestEdge === "left" ? "left-0" : "right-0",
          )}
        />
      )}
      {canReorderColumn && (
        <div
          aria-hidden="true"
          className="text-muted-foreground hover:text-foreground border-border/70 bg-background absolute top-1/2 left-2 z-40 flex size-5 -translate-y-1/2 cursor-grab items-center justify-center rounded border opacity-0 shadow-sm transition-opacity group-hover/table-head:opacity-100 active:cursor-grabbing"
          data-row-expansion-ignore
          ref={dragHandleRef}
        >
          <GripVerticalIcon className="size-3.5" />
        </div>
      )}
      {headerContent}
      {header.column.getCanResize() && (
        <button
          className="user-select-none absolute top-0 -right-2 z-30 hidden h-full w-4 cursor-col-resize touch-none py-1 group-hover/table-head:flex"
          data-row-expansion-ignore
          onDoubleClick={() => header.column.resetSize()}
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          type="button"
        >
          <span className="bg-primary/25 mr-auto h-full w-1 rounded" />
        </button>
      )}
    </WorkspaceGridHead>
  );
};

type SelectAllHeaderProps = {
  state: SelectAllState;
  onToggle: () => void;
};

const SelectAllHeader = ({ state, onToggle }: SelectAllHeaderProps) => {
  const ariaChecked = state.indeterminate ? "mixed" : state.checked;

  return (
    <div className="flex items-center justify-center">
      <button
        aria-checked={ariaChecked}
        className={cn(
          "ring-ring focus-visible:ring-offset-background inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border shadow-xs/5 transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
          (state.checked || state.indeterminate) &&
            "bg-primary border-primary text-primary-foreground shadow-none",
          !(state.checked || state.indeterminate) &&
            "border-input bg-background",
        )}
        data-select-all-state={state.key}
        onClick={onToggle}
        // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="checkbox"
        type="button"
      >
        {(() => {
          if (state.indeterminate) {
            return <MinusIcon className="size-3" strokeWidth={3} />;
          }
          if (state.checked) {
            return <CheckIcon className="size-3" strokeWidth={3} />;
          }
          return null;
        })()}
      </button>
    </div>
  );
};

export const HeaderEndFillerCell = ({
  renderColumns,
  addPropertyColumn,
}: EndFillerInput) => (
  <WorkspaceGridHead
    aria-hidden="true"
    className={cn("pointer-events-none", addPropertyColumn && "border-e-0")}
    role="presentation"
    style={{
      gridColumn: getEndFillerGridColumn({
        renderColumns,
        addPropertyColumn,
      }),
    }}
  />
);

export const getOrderedHeaders = (
  headers: TableHeader[],
  columns: Column<TableTreeNode>[],
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
    throw new Error(`Missing header for workspace table column "${columnId}"`);
  }

  return header;
};
