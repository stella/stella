import type { CSSProperties } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { Checkbox } from "@stll/ui/components/checkbox";
import { toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { flexRender } from "@tanstack/react-table";
import type {
  Cell,
  Column,
  Table as ReactTable,
  Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Header } from "@tanstack/table-core";
import {
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GripVerticalIcon,
  MinusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { renderDragPreview } from "@/components/drag-preview";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type { VirtualAnchor } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import {
  getNextSelectAllRowSelection,
  getSelectAllState,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/select-all.logic";
import type { SelectAllState } from "@/routes/_protected.workspaces/$workspaceId/-components/table/select-all.logic";
import type {
  TableTreeNode,
  WorkspaceTable as WorkspaceTableType,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridFillerCell,
  WorkspaceGridHead,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import {
  getGridTemplateColumns,
  getOrderedCells,
  getOrderedColumns,
  reorderColumnIds,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import type { ColumnDropEdge } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  countDescendants,
  getEntityName,
  getFirstFile,
  getInternalColId,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
const TABLE_ROW_ESTIMATE_PX = 41;
const TABLE_ROW_OVERSCAN = 16;
const EXPANDED_ROW_MAX_HEIGHT_PX = 192;
const TABLE_COLUMN_DRAG_TYPE = "workspace-table-column";
const ADD_COLUMN_HOVER_COLOR =
  "color-mix(in srgb, var(--color-foreground) 4%, var(--color-background))";

type WorkspaceGridStyle = CSSProperties & {
  "--workspace-table-columns": string;
};

type WorkspaceTableProps = {
  workspaceId: string;
  table: WorkspaceTableType;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
};

type ColumnDragData = {
  type: typeof TABLE_COLUMN_DRAG_TYPE;
  columnId: string;
  pinning: ColumnDragPinning;
};

type ColumnDragPinning = "left" | "right" | "center";

type ColumnDropPosition = {
  sourceId: string;
  targetId: string;
  edge: ColumnDropEdge;
};

export const WorkspaceTable = ({
  workspaceId,
  table,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
}: WorkspaceTableProps) => {
  const t = useTranslations();
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndex = useRef<number | null>(null);
  const previousHorizontalMaxScroll = useRef<number | null>(null);
  const lastColumnDropPosition = useRef<ColumnDropPosition | null>(null);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const [addColumnHoverRowId, setAddColumnHoverRowId] = useState<string | null>(
    null,
  );
  const [isAddColumnHovered, setIsAddColumnHovered] = useState(false);
  const expandedTableRowEntityId = useWorkspaceStore(
    (s) => s.expandedTableRowEntityId,
  );
  const setExpandedTableRowEntityId = useWorkspaceStore(
    (s) => s.setExpandedTableRowEntityId,
  );

  const renameEntity = useRenameEntity();

  const activeEntityId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "pdf" ? tab.entityId : null;
  });

  const activeTaskId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "task" ? tab.id : null;
  });

  const rowModel = table.getRowModel();
  const selectableRowIds = useMemo(
    () =>
      rowModel.rows.filter((row) => row.getCanSelect()).map((row) => row.id),
    [rowModel.rows],
  );
  const selectAllState = getSelectAllState({
    selectableRowIds,
    rowSelection: table.getState().rowSelection,
  });
  const handleToggleSelectAll = useCallback(() => {
    table.setRowSelection(
      getNextSelectAllRowSelection({
        selectableRowIds,
        rowSelection: table.getState().rowSelection,
      }),
    );
  }, [selectableRowIds, table]);

  const rowLabels = useMemo(() => {
    // Compute logical row labels that account for collapsed
    // folder children. Each visible row gets a 1-based number;
    // collapsed folders show a range.
    const labels: string[] = [];
    let logicalPos = 1;
    for (const row of rowModel.rows) {
      const isFolder = row.original.kind === "folder";
      const isCollapsed = isFolder && !row.getIsExpanded();

      if (isCollapsed) {
        const descendantCount = countDescendants(row.original);
        if (descendantCount > 0) {
          labels.push(`${logicalPos}-${logicalPos + descendantCount}`);
          logicalPos += descendantCount + 1;
        } else {
          labels.push(String(logicalPos));
          logicalPos += 1;
        }
      } else {
        labels.push(String(logicalPos));
        logicalPos += 1;
      }
    }
    return labels;
  }, [rowModel]);
  const getVirtualRowKey = useCallback(
    (index: number) =>
      rowModel.rows.at(index)?.original.entityId ?? `table-row-${index}`,
    [rowModel.rows],
  );
  const rowVirtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => tableWrapperRef.current,
    estimateSize: () => TABLE_ROW_ESTIMATE_PX,
    getItemKey: getVirtualRowKey,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: TABLE_ROW_OVERSCAN,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastVirtualRow = virtualRows.at(-1);
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || !onLoadMore || !lastVirtualRow) {
      return;
    }

    const shouldLoadMore =
      lastVirtualRow.index >= rowModel.rows.length - 1 - TABLE_ROW_OVERSCAN;
    if (shouldLoadMore) {
      onLoadMore();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    lastVirtualRow,
    onLoadMore,
    rowModel.rows.length,
  ]);
  const paddingTop = virtualRows.at(0)?.start ?? 0;
  const paddingBottom =
    rowVirtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0);
  const orderedColumns = getOrderedColumns({
    leftColumns: table.getLeftLeafColumns(),
    centerColumns: table.getCenterLeafColumns(),
    rightColumns: table.getRightLeafColumns(),
  });
  const addPropertyColumn =
    orderedColumns.find((column) => column.id === addPropertyColId) ?? null;
  const renderColumns = orderedColumns.filter(
    (column) => column.id !== addPropertyColId,
  );
  const visibleColumnCount = renderColumns.length + (addPropertyColumn ? 1 : 0);
  const tableWidth = orderedColumns.reduce(
    (sum, column) => sum + column.getSize(),
    0,
  );
  const leftoverWidth = Math.max(0, wrapperWidth - tableWidth);
  const trailingFillerWidth = leftoverWidth;
  const gridStyle: WorkspaceGridStyle = {
    "--workspace-table-columns": getGridTemplateColumns(
      renderColumns,
      trailingFillerWidth,
      addPropertyColumn ? [addPropertyColumn] : [],
    ),
    minWidth: tableWidth + trailingFillerWidth,
  };
  const horizontalMaxScroll = Math.max(
    0,
    tableWidth + trailingFillerWidth - wrapperWidth,
  );
  const handleColumnReorder = useCallback(
    (sourceId: string, targetId: string, edge: ColumnDropEdge) => {
      const currentVisibleIds = orderedColumns.map((column) => column.id);
      const reorderedVisibleIds = reorderColumnIds({
        ids: currentVisibleIds,
        sourceId,
        targetId,
        edge,
      });
      const visibleIdSet = new Set(currentVisibleIds);
      const hiddenIds = table
        .getAllLeafColumns()
        .map((column) => column.id)
        .filter((id) => !visibleIdSet.has(id));

      table.setColumnOrder([...reorderedVisibleIds, ...hiddenIds]);
    },
    [orderedColumns, table],
  );

  useEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) {
      return undefined;
    }

    return combine(
      autoScrollForElements({
        element,
        getAllowedAxis: () => "horizontal",
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => source.data["type"] === ENTITY_DRAG_TYPE,
        onDrop: ({ source }) => {
          if (source.data["type"] !== ENTITY_DRAG_TYPE) {
            return;
          }
          toastManager.add({
            title: t("workspaces.table.reorderReadOnly"),
            type: "info",
          });
        },
      }),
      monitorForElements({
        canMonitor: ({ source }) =>
          source.data["type"] === TABLE_COLUMN_DRAG_TYPE,
        onDragStart: () => {
          lastColumnDropPosition.current = null;
        },
        onDrag: ({ source, location }) => {
          const target = location.current.dropTargets.at(0);
          if (!target) {
            return;
          }

          const edge = toColumnDropEdge(extractClosestEdge(target.data));
          const sourceColumnId = source.data["columnId"];
          const targetColumnId = target.data["columnId"];
          if (
            edge &&
            typeof sourceColumnId === "string" &&
            typeof targetColumnId === "string" &&
            sourceColumnId !== targetColumnId
          ) {
            lastColumnDropPosition.current = {
              sourceId: sourceColumnId,
              targetId: targetColumnId,
              edge,
            };
          }
        },
        onDrop: () => {
          const position = lastColumnDropPosition.current;
          lastColumnDropPosition.current = null;
          if (position) {
            handleColumnReorder(
              position.sourceId,
              position.targetId,
              position.edge,
            );
          }
        },
      }),
    );
  }, [handleColumnReorder, t]);

  useEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) {
      return undefined;
    }

    setWrapperWidth(element.clientWidth);

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) {
        setWrapperWidth(entry.contentRect.width);
      }
    });
    resizeObserver.observe(element);

    return () => resizeObserver.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) {
      return;
    }

    const previousMax = previousHorizontalMaxScroll.current;
    previousHorizontalMaxScroll.current = horizontalMaxScroll;
    if (previousMax === null) {
      return;
    }

    const wasAtRightEdge = element.scrollLeft >= previousMax - 2;
    if (wasAtRightEdge) {
      element.scrollLeft = horizontalMaxScroll;
      return;
    }

    if (element.scrollLeft > horizontalMaxScroll) {
      element.scrollLeft = horizontalMaxScroll;
    }
  }, [horizontalMaxScroll]);

  return (
    <div className="relative h-full flex-1 overflow-auto" ref={tableWrapperRef}>
      <div
        aria-colcount={visibleColumnCount}
        aria-rowcount={rowModel.rows.length}
        className="relative min-h-full w-full text-sm"
        role="grid"
        style={gridStyle}
      >
        <div className="bg-background sticky top-0 z-30">
          {table.getHeaderGroups().map((headerGroup) => (
            <WorkspaceGridRow key={headerGroup.id}>
              {getOrderedHeaders(headerGroup.headers, renderColumns).map(
                (header, index) => (
                  <DraggableHeaderCell
                    addColumnHovered={isAddColumnHovered}
                    header={header}
                    index={index}
                    key={header.id}
                    onAddColumnHoverChange={setIsAddColumnHovered}
                    onToggleSelectAll={handleToggleSelectAll}
                    selectAllState={selectAllState}
                  />
                ),
              )}
              <WorkspaceGridHead
                aria-hidden="true"
                className="border-e-0"
                role="presentation"
              />
              {addPropertyColumn && (
                <DraggableHeaderCell
                  addColumnHovered={isAddColumnHovered}
                  header={getRequiredHeader(
                    headerGroup.headers,
                    addPropertyColumn.id,
                  )}
                  index={renderColumns.length}
                  onAddColumnHoverChange={setIsAddColumnHovered}
                  onToggleSelectAll={handleToggleSelectAll}
                  selectAllState={selectAllState}
                />
              )}
            </WorkspaceGridRow>
          ))}
        </div>
        <div>
          {paddingTop > 0 && (
            <WorkspaceGridRow aria-hidden="true">
              <WorkspaceGridFillerCell
                className="border-b-0"
                style={{
                  gridColumn: addPropertyColumn ? "1 / -2" : "1 / -1",
                  height: paddingTop,
                }}
              />
              {addPropertyColumn && (
                <AddPropertyRailSpacer
                  addColumnHovered={isAddColumnHovered}
                  height={paddingTop}
                />
              )}
            </WorkspaceGridRow>
          )}
          {virtualRows.map((virtualRow) => {
            const row = rowModel.rows.at(virtualRow.index);
            if (!row) {
              return null;
            }

            return (
              <DraggableRow
                activeEntityId={activeEntityId}
                activeTaskId={activeTaskId}
                addColumnHoverRowId={addColumnHoverRowId}
                addColumnHovered={isAddColumnHovered}
                editingEntityId={editingEntityId}
                expanded={expandedTableRowEntityId === row.original.entityId}
                index={virtualRow.index}
                key={row.id}
                lastSelectedIndex={lastSelectedIndex}
                measureElement={rowVirtualizer.measureElement}
                onRename={(entityId, newName) => {
                  renameEntity.mutate({
                    workspaceId,
                    entityId,
                    name: newName,
                  });
                }}
                onStartEditing={setEditingEntityId}
                onStopEditing={() => setEditingEntityId(null)}
                onAddColumnHoverChange={(hovered) => {
                  setIsAddColumnHovered(hovered);
                  setAddColumnHoverRowId(hovered ? row.id : null);
                }}
                onToggleExpanded={(entityId) => {
                  setExpandedTableRowEntityId(
                    expandedTableRowEntityId === entityId ? null : entityId,
                  );
                }}
                addPropertyColumn={addPropertyColumn}
                row={row}
                rowLabel={rowLabels[virtualRow.index] ?? ""}
                renderColumns={renderColumns}
                table={table}
                virtualIndex={virtualRow.index}
                workspaceId={workspaceId}
              />
            );
          })}
          {paddingBottom > 0 && (
            <WorkspaceGridRow aria-hidden="true">
              <WorkspaceGridFillerCell
                className="border-b-0"
                style={{
                  gridColumn: addPropertyColumn ? "1 / -2" : "1 / -1",
                  height: paddingBottom,
                }}
              />
              {addPropertyColumn && (
                <AddPropertyRailSpacer
                  addColumnHovered={isAddColumnHovered}
                  height={paddingBottom}
                />
              )}
            </WorkspaceGridRow>
          )}
          <BottomRow
            onFolderCreated={setEditingEntityId}
            table={table}
            workspaceId={workspaceId}
          />
        </div>
      </div>
    </div>
  );
};

type DraggableHeaderCellProps = {
  header: Header<TableTreeNode, unknown>;
  index: number;
  addColumnHovered: boolean;
  onAddColumnHoverChange: (hovered: boolean) => void;
  onToggleSelectAll: () => void;
  selectAllState: SelectAllState;
};

const DraggableHeaderCell = ({
  header,
  index,
  addColumnHovered,
  onAddColumnHoverChange,
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

  return (
    <WorkspaceGridHead
      aria-colindex={index + 1}
      className={cn(
        "relative",
        isAddPropertyColumn && "border-s",
        isDragging && "opacity-50",
        closestEdge && "overflow-visible",
        header.column.getIsResizing() &&
          "after:bg-info after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-50 after:w-px",
      )}
      ref={headerRef}
      onPointerEnter={
        isAddPropertyColumn ? () => onAddColumnHoverChange(true) : undefined
      }
      onPointerDown={
        isAddPropertyColumn ? () => onAddColumnHoverChange(false) : undefined
      }
      onPointerLeave={
        isAddPropertyColumn ? () => onAddColumnHoverChange(false) : undefined
      }
      style={{
        ...getGridPinningStyles(header.column),
        ...getAddColumnHoverStyles(isAddPropertyColumn && addColumnHovered),
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
          className="text-muted-foreground hover:text-foreground border-border/70 bg-background/95 absolute top-1/2 left-2 z-40 flex size-5 -translate-y-1/2 cursor-grab items-center justify-center rounded border opacity-0 shadow-sm transition-opacity group-hover/table-head:opacity-100 active:cursor-grabbing"
          data-row-expansion-ignore
          ref={dragHandleRef}
        >
          <GripVerticalIcon className="size-3.5" />
        </div>
      )}
      {header.column.id === selectColId ? (
        <SelectAllHeader onToggle={onToggleSelectAll} state={selectAllState} />
      ) : header.isPlaceholder ? null : (
        flexRender(header.column.columnDef.header, header.getContext())
      )}
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

const getOrderedHeaders = (
  headers: Header<TableTreeNode, unknown>[],
  columns: Column<TableTreeNode>[],
) => {
  const headersByColumnId = new Map(
    headers.map((header) => [header.column.id, header]),
  );
  const orderedHeaders: Header<TableTreeNode, unknown>[] = [];

  for (const column of columns) {
    const header = headersByColumnId.get(column.id);
    if (header) {
      orderedHeaders.push(header);
    }
  }

  return orderedHeaders;
};

const getRequiredHeader = (
  headers: Header<TableTreeNode, unknown>[],
  columnId: string,
) => {
  const header = headers.find((candidate) => candidate.column.id === columnId);
  if (!header) {
    throw new Error(`Missing header for workspace table column "${columnId}"`);
  }

  return header;
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
        {state.indeterminate ? (
          <MinusIcon className="size-3" strokeWidth={3} />
        ) : state.checked ? (
          <CheckIcon className="size-3" strokeWidth={3} />
        ) : null}
      </button>
    </div>
  );
};

const getGridPinningStyles = (column: Column<TableTreeNode>): CSSProperties => {
  if (column.id === addPropertyColId) {
    return {
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
    zIndex: column.id === selectColId ? 3 : 2,
  };
};

const getAddColumnHoverStyles = (hovered: boolean): CSSProperties => {
  if (!hovered) {
    return {};
  }

  return {
    backgroundColor: ADD_COLUMN_HOVER_COLOR,
    borderBottomColor: ADD_COLUMN_HOVER_COLOR,
  };
};

type PinnedBoundaryProps = {
  column: Column<TableTreeNode>;
};

const PinnedBoundary = ({ column }: PinnedBoundaryProps) => {
  const isLeftPinned = column.getIsPinned() === "left";
  const isLastLeftPinned = isLeftPinned && column.getIsLastColumn("left");
  if (!isLastLeftPinned || column.id === selectColId) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-0 z-40 w-1"
    >
      <span className="bg-border absolute inset-y-0 left-0 w-px" />
      <span className="bg-border absolute inset-y-0 right-0 w-px" />
    </span>
  );
};

const getColumnPinningGroup = (
  column: Column<TableTreeNode>,
): ColumnDragPinning => {
  const pinning = column.getIsPinned();
  if (pinning === "left" || pinning === "right") {
    return pinning;
  }

  return "center";
};

const getColumnDragData = (
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

const toColumnDropEdge = (edge: Edge | null): ColumnDropEdge | null => {
  if (edge === "left" || edge === "right") {
    return edge;
  }

  return null;
};

const shouldIgnoreRowExpansionClick = (target: EventTarget) => {
  if (!(target instanceof HTMLElement)) {
    return true;
  }

  return Boolean(
    target.closest(
      "button, a, input, textarea, select, [role='button'], [role='checkbox'], [data-row-expansion-ignore], [data-slot='select-trigger']",
    ),
  );
};

// -- Draggable table row --

type DraggableRowProps = {
  row: Row<TableTreeNode>;
  virtualIndex: number;
  index: number;
  rowLabel: string;
  renderColumns: Column<TableTreeNode>[];
  addPropertyColumn: Column<TableTreeNode> | null;
  table: WorkspaceTableType;
  workspaceId: string;
  activeEntityId: string | null;
  activeTaskId: string | null;
  addColumnHoverRowId: string | null;
  addColumnHovered: boolean;
  editingEntityId: string | null;
  expanded: boolean;
  lastSelectedIndex: React.RefObject<number | null>;
  measureElement: (element: Element | null) => void;
  onAddColumnHoverChange: (hovered: boolean) => void;
  onRename: (entityId: string, newName: string) => void;
  onStartEditing: (entityId: string) => void;
  onStopEditing: () => void;
  onToggleExpanded: (entityId: string) => void;
};

const DraggableRow = ({
  row,
  virtualIndex,
  index,
  rowLabel,
  renderColumns,
  addPropertyColumn,
  table,
  workspaceId,
  activeEntityId,
  activeTaskId,
  addColumnHoverRowId,
  addColumnHovered,
  editingEntityId,
  expanded,
  lastSelectedIndex,
  measureElement,
  onAddColumnHoverChange,
  onRename,
  onStartEditing,
  onStopEditing,
  onToggleExpanded,
}: DraggableRowProps) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const setRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      rowRef.current = element;
      measureElement(element);
    },
    [measureElement],
  );
  const bulkEntitiesRef = useRef<TableTreeNode[] | undefined>(undefined);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<VirtualAnchor | null>(
    null,
  );
  const entity = row.original;

  useInspectorFlash(entity.entityId, rowRef);
  const isFolder = entity.kind === "folder";
  const isTask = entity.kind === "task";
  const isAddColumnHoverRow = addColumnHoverRowId === row.id;
  const visibleCells = getOrderedCells(row.getVisibleCells(), renderColumns);
  const addPropertyCell = addPropertyColumn
    ? row
        .getVisibleCells()
        .find((cell) => cell.column.id === addPropertyColumn.id)
    : undefined;
  const name = getEntityName(entity);
  const file = getFirstFile(entity);

  const getBulkSelectedEntities = () => {
    const selectedRows = table.getSelectedRowModel().rows;
    if (!row.getIsSelected() || selectedRows.length <= 1) {
      return undefined;
    }
    return selectedRows.map((selectedRow) => selectedRow.original);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    bulkEntitiesRef.current = getBulkSelectedEntities();
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0),
    });
    setContextOpen(true);
  };

  const handleRowClick = (e: React.MouseEvent) => {
    if (shouldIgnoreRowExpansionClick(e.target)) {
      return;
    }

    if (isTask) {
      useInspectorStore.getState().openTask(entity.entityId, name);
      return;
    }

    if (!isFolder) {
      onToggleExpanded(entity.entityId);
    }
  };

  const selectCellContent = (
    <SelectRowContent
      index={index}
      label={rowLabel}
      lastSelectedIndex={lastSelectedIndex}
      row={row}
      table={table}
    />
  );

  const rowActions = (
    <RowActions
      anchor={contextAnchor}
      entity={entity}
      onOpenChange={(open) => {
        if (open) {
          bulkEntitiesRef.current = getBulkSelectedEntities();
        }
        setContextOpen(open);
        if (!open) {
          setContextAnchor(null);
          bulkEntitiesRef.current = undefined;
        }
      }}
      onRename={isFolder ? () => onStartEditing(entity.entityId) : undefined}
      open={contextOpen}
      selectedEntities={contextOpen ? bulkEntitiesRef.current : undefined}
      triggerClassName="opacity-0! transition-opacity group-hover/row:opacity-100! focus-visible:opacity-100!"
      workspaceId={workspaceId}
    />
  );

  // Kebab stays mounted (right-click context menu uses the same Menu),
  // but the visible trigger is hidden so the row checkbox owns this
  // slot. We use sr-only positioning rather than `display: none` so
  // keyboard users can still Tab to it and open the actions menu.
  const selectCellWithActions = (
    <>
      {selectCellContent}
      <span className="sr-only">{rowActions}</span>
    </>
  );

  useEffect(() => {
    if (rowRef.current) {
      measureElement(rowRef.current);
    }
  }, [expanded, measureElement]);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) {
      return undefined;
    }

    return draggable({
      element: el,
      getInitialData: () => ({
        type: ENTITY_DRAG_TYPE,
        entityId: entity.entityId,
        entityIds: [entity.entityId],
        entities: [
          {
            entityId: entity.entityId,
            name,
            kind: entity.kind,
            mimeType: file?.mimeType ?? null,
            parentId: entity.parentId ?? null,
          },
        ],
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          render: ({ container }) =>
            renderDragPreview(container, {
              name,
              kind: entity.kind,
              mimeType: file?.mimeType ?? null,
            }),
        });
      },
    });
  }, [entity.entityId, entity.kind, entity.parentId, name, file?.mimeType]);

  if (isFolder && visibleCells.length > 2) {
    const selectCell = visibleCells[0];
    const nameCell = visibleCells[1];
    if (!selectCell || !nameCell) {
      return null;
    }
    return (
      <WorkspaceGridRow
        aria-rowindex={virtualIndex + 2}
        aria-selected={row.getIsSelected()}
        data-active={entity.entityId === activeEntityId || undefined}
        data-index={virtualIndex}
        data-state={row.getIsSelected() ? "selected" : undefined}
        key={row.id}
        onContextMenu={handleContextMenu}
        ref={setRowRef}
      >
        <WorkspaceGridCell
          aria-colindex={1}
          data-state={row.getIsSelected() ? "selected" : undefined}
          key={selectCell.id}
          style={{
            ...getGridPinningStyles(selectCell.column),
          }}
        >
          <PinnedBoundary column={selectCell.column} />
          {selectCellWithActions}
        </WorkspaceGridCell>
        <WorkspaceGridCell
          aria-colindex={2}
          className="cursor-pointer"
          data-state={row.getIsSelected() ? "selected" : undefined}
          key={nameCell.id}
          onClick={() => row.toggleExpanded()}
          style={{
            ...getGridPinningStyles(nameCell.column),
          }}
        >
          <PinnedBoundary column={nameCell.column} />
          <FolderCell
            depth={row.depth}
            editingEntityId={editingEntityId}
            entity={entity}
            isExpanded={row.getIsExpanded()}
            onRename={onRename}
            onStopEditing={onStopEditing}
            startEditing={() => onStartEditing(entity.entityId)}
          />
        </WorkspaceGridCell>
        <WorkspaceGridCell
          aria-colindex={3}
          className="cursor-pointer border-e-0"
          data-state={row.getIsSelected() ? "selected" : undefined}
          onClick={() => row.toggleExpanded()}
          style={{ gridColumn: addPropertyCell ? "3 / -2" : "3 / -1" }}
        />
        <FolderAddPropertyCell
          addColumnHovered={addColumnHovered}
          cell={addPropertyCell}
          columnIndex={renderColumns.length + 1}
          onAddColumnHoverChange={onAddColumnHoverChange}
          selected={row.getIsSelected()}
        />
      </WorkspaceGridRow>
    );
  }

  return (
    <WorkspaceGridRow
      aria-expanded={expanded}
      aria-rowindex={virtualIndex + 2}
      aria-selected={row.getIsSelected()}
      className={cn((isTask || !isFolder) && "cursor-pointer")}
      data-active={
        entity.entityId === activeEntityId ||
        entity.entityId === activeTaskId ||
        undefined
      }
      data-index={virtualIndex}
      data-state={row.getIsSelected() ? "selected" : undefined}
      key={row.id}
      onClick={handleRowClick}
      onContextMenu={handleContextMenu}
      ref={setRowRef}
    >
      {visibleCells.map((cell, cellIndex) => (
        <WorkspaceGridCell
          aria-colindex={cellIndex + 1}
          className={cn(
            "relative",
            isAddColumnHoverRow && "group-hover/row:bg-background",
            cell.column.id === selectColId && "min-w-12 shrink-0",
            cell.column.columnDef.meta?.muted && "text-muted-foreground",
            expanded &&
              "max-h-48 overflow-y-auto whitespace-normal [&_.line-clamp-2]:line-clamp-none [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal",
            cell.column.getIsResizing() &&
              "after:bg-info after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-50 after:w-px",
          )}
          data-state={cell.row.getIsSelected() ? "selected" : undefined}
          key={cell.id}
          onPointerEnter={
            cell.column.id === addPropertyColId
              ? () => onAddColumnHoverChange(true)
              : undefined
          }
          onPointerDown={
            cell.column.id === addPropertyColId
              ? () => onAddColumnHoverChange(false)
              : undefined
          }
          onPointerLeave={
            cell.column.id === addPropertyColId
              ? () => onAddColumnHoverChange(false)
              : undefined
          }
          style={{
            ...getGridPinningStyles(cell.column),
            ...getAddColumnHoverStyles(
              cell.column.id === addPropertyColId && addColumnHovered,
            ),
            maxHeight: expanded ? EXPANDED_ROW_MAX_HEIGHT_PX : undefined,
          }}
        >
          <PinnedBoundary column={cell.column} />
          {cell.column.id === selectColId ? (
            selectCellWithActions
          ) : (
            <span className="flex w-full min-w-0 items-center gap-1.5">
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </span>
          )}
        </WorkspaceGridCell>
      ))}
      <WorkspaceGridFillerCell
        className={cn(isAddColumnHoverRow && "group-hover/row:bg-background")}
      />
      <AddPropertyCell
        addColumnHovered={addColumnHovered}
        cell={addPropertyCell}
        columnIndex={renderColumns.length + 1}
        onAddColumnHoverChange={onAddColumnHoverChange}
        selected={row.getIsSelected()}
      />
    </WorkspaceGridRow>
  );
};

type FolderAddPropertyCellProps = {
  cell: Cell<TableTreeNode, unknown> | undefined;
  columnIndex: number;
  selected: boolean;
  addColumnHovered: boolean;
  onAddColumnHoverChange: (hovered: boolean) => void;
};

const FolderAddPropertyCell = ({
  cell,
  columnIndex,
  selected,
  addColumnHovered,
  onAddColumnHoverChange,
}: FolderAddPropertyCellProps) => (
  <AddPropertyCell
    addColumnHovered={addColumnHovered}
    cell={cell}
    columnIndex={columnIndex}
    onAddColumnHoverChange={onAddColumnHoverChange}
    selected={selected}
  />
);

const AddPropertyCell = ({
  cell,
  columnIndex,
  selected,
  addColumnHovered,
  onAddColumnHoverChange,
}: FolderAddPropertyCellProps) => {
  if (!cell) {
    return null;
  }

  return (
    <WorkspaceGridCell
      aria-colindex={columnIndex}
      className="group-hover/row:bg-background group-data-[state=selected]/row:bg-background group-data-[state=selected]/row:group-hover/row:bg-background border-s p-0"
      data-state={selected ? "selected" : undefined}
      onPointerEnter={() => onAddColumnHoverChange(true)}
      onPointerDown={() => onAddColumnHoverChange(false)}
      onPointerLeave={() => onAddColumnHoverChange(false)}
      style={{
        ...getGridPinningStyles(cell.column),
        ...getAddColumnHoverStyles(addColumnHovered),
      }}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </WorkspaceGridCell>
  );
};

type AddPropertyRailSpacerProps = {
  addColumnHovered: boolean;
  height: number;
};

const AddPropertyRailSpacer = ({
  addColumnHovered,
  height,
}: AddPropertyRailSpacerProps) => (
  <WorkspaceGridCell
    aria-hidden="true"
    className="group-hover/row:bg-background border-s border-b-0 p-0"
    role="presentation"
    style={{
      gridColumn: "-2 / -1",
      height,
      position: "sticky",
      right: 0,
      zIndex: 2,
      ...getAddColumnHoverStyles(addColumnHovered),
    }}
  />
);

// -- Select row content --

type SelectRowContentProps = {
  index: number;
  label: string;
  row: Row<TableTreeNode>;
  table: ReactTable<TableTreeNode>;
  lastSelectedIndex: React.RefObject<number | null>;
};

const SelectRowContent = ({
  index,
  label,
  row,
  table,
  lastSelectedIndex,
}: SelectRowContentProps) => {
  const isFolder = row.original.kind === "folder";
  const someSelected =
    isFolder && row.subRows.length > 0 && row.getIsSomeSelected();

  const handleChange = (_checked: boolean, eventDetails: { event: Event }) => {
    if (
      eventDetails.event instanceof PointerEvent &&
      eventDetails.event.shiftKey &&
      lastSelectedIndex.current !== null
    ) {
      const start = Math.min(lastSelectedIndex.current, index);
      const end = Math.max(lastSelectedIndex.current, index);
      const rows = table.getRowModel().rows;
      const patch: Record<string, boolean> = {};
      for (let i = start; i <= end; i++) {
        const r = rows[i];
        if (r) {
          patch[r.id] = true;
        }
      }
      table.setRowSelection((prev) => ({
        ...prev,
        ...patch,
      }));
    } else {
      row.toggleSelected();
    }
    lastSelectedIndex.current = index;
  };

  return (
    <div className="absolute inset-0 flex min-w-12 shrink-0 items-center justify-center">
      <span className="absolute inset-0 flex min-w-12 shrink-0 items-center justify-center text-xs tabular-nums transition-opacity group-hover/row:opacity-0 group-data-[state=selected]/row:opacity-0">
        {label}
      </span>
      <Checkbox
        checked={row.getIsSelected()}
        className="pointer-events-none absolute shrink-0 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-data-[state=selected]/row:pointer-events-auto group-data-[state=selected]/row:opacity-100"
        indeterminate={someSelected}
        onCheckedChange={handleChange}
        tabIndex={row.getIsSelected() ? 0 : -1}
      />
    </div>
  );
};

// -- Folder cell --

type FolderCellProps = {
  entity: TableTreeNode;
  depth: number;
  isExpanded: boolean;
  editingEntityId: string | null;
  startEditing: () => void;
  onStopEditing: () => void;
  onRename: (entityId: string, newName: string) => void;
};

const FolderCell = ({
  entity,
  depth,
  isExpanded,
  editingEntityId,
  startEditing,
  onStopEditing,
  onRename,
}: FolderCellProps) => {
  const name = getEntityName(entity);
  const isEditing = editingEntityId === entity.entityId;
  const [editValue, setEditValue] = useState(name);

  const commitRename = () => {
    onStopEditing();
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) {
      onRename(entity.entityId, trimmed);
    }
  };

  return (
    <div
      className="flex w-full items-center gap-1"
      style={{
        paddingLeft: depth > 0 ? `${depth * 20}px` : undefined,
      }}
    >
      <button className="flex shrink-0 items-center" type="button">
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform",
            isExpanded && "rotate-90",
          )}
        />
      </button>
      {isExpanded ? (
        <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" />
      ) : (
        <FolderIcon className="text-muted-foreground size-4 shrink-0" />
      )}
      {isEditing ? (
        <InlineEdit
          inputClassName="w-48"
          onCancel={() => {
            onStopEditing();
            setEditValue(name);
          }}
          onChange={setEditValue}
          onCommit={commitRename}
          value={editValue}
        />
      ) : (
        <button
          className="truncate text-start text-sm"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditValue(name);
            startEditing();
          }}
          type="button"
        >
          {name}
        </button>
      )}
    </div>
  );
};
