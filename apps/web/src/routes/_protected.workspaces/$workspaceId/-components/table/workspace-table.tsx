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

import { Checkbox } from "@stll/ui/components/checkbox";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { renderDragPreview } from "@/components/drag-preview";
import { TOOLBAR_ROW_HEIGHT, TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
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
import type { TableContentMode } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import {
  countDescendants,
  getEntityName,
  getFirstFile,
  getInternalColId,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
const TABLE_ROW_ESTIMATE_PX = TOOLBAR_ROW_HEIGHT_PX;
const TABLE_ROW_OVERSCAN = 16;
const TABLE_COLUMN_DRAG_TYPE = "workspace-table-column";
const TABLE_END_FILLER_LINE =
  "color-mix(in srgb, var(--color-border) 30%, transparent)";
const TABLE_END_FILLER_BACKGROUND = `repeating-linear-gradient(
  to bottom,
  transparent 0,
  transparent ${TABLE_ROW_ESTIMATE_PX - 1}px,
  ${TABLE_END_FILLER_LINE} ${TABLE_ROW_ESTIMATE_PX - 1}px,
  ${TABLE_END_FILLER_LINE} ${TABLE_ROW_ESTIMATE_PX}px
)`;
const ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME =
  "[&:has([data-add-property-trigger]:hover)_[data-add-property-surface]]:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] [&:has([data-add-property-trigger]:focus-visible)_[data-add-property-surface]]:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))]";

type WorkspaceGridStyle = CSSProperties & {
  "--workspace-table-columns": string;
};

type EndFillerInput = {
  renderColumns: Column<TableTreeNode>[];
  addPropertyColumn: Column<TableTreeNode> | null;
};

const tableEndFillerCellStyle: CSSProperties = {
  backgroundImage: TABLE_END_FILLER_BACKGROUND,
};

const getVerticalScrollbarWidth = (element: HTMLElement) =>
  Math.max(0, element.offsetWidth - element.clientWidth);

type WorkspaceTableProps = {
  workspaceId: string;
  table: WorkspaceTableType;
  contentMode: TableContentMode;
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

type ExpandedTableCell = {
  entityId: string;
  columnId: string;
};

export const WorkspaceTable = ({
  workspaceId,
  table,
  contentMode,
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
  const [expandedTableCell, setExpandedTableCell] =
    useState<ExpandedTableCell | null>(null);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const [verticalScrollbarWidth, setVerticalScrollbarWidth] = useState(0);

  useEffect(() => {
    if (!expandedTableCell) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-expanded-cell='true']")
      ) {
        return;
      }
      setExpandedTableCell(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      setExpandedTableCell(null);
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expandedTableCell]);

  const renameEntity = useRenameEntity();

  const activeEntityId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "pdf" ? tab.entityId : null;
  });
  const activePropertyId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "pdf" ? (tab.propertyId ?? null) : null;
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
  }).filter((column) => column.getIsVisible());
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
  const gridWidth = Math.max(tableWidth, wrapperWidth);
  const gridStyle: WorkspaceGridStyle = {
    "--workspace-table-columns": getWorkspaceGridTemplateColumns({
      renderColumns,
      addPropertyColumn,
    }),
    minWidth: tableWidth,
    width: gridWidth,
  };
  const horizontalMaxScroll = Math.max(0, gridWidth - wrapperWidth);
  const handleColumnReorder = useCallback(
    (sourceId: string, targetId: string, edge: ColumnDropEdge) => {
      const sourceColumn = table.getColumn(sourceId);
      const targetColumn = table.getColumn(targetId);
      if (!sourceColumn || !targetColumn) {
        return;
      }

      const pinning = getColumnPinningGroup(sourceColumn);
      if (
        pinning !== "center" &&
        pinning === getColumnPinningGroup(targetColumn)
      ) {
        table.setColumnPinning((prev) => ({
          ...prev,
          [pinning]: reorderColumnIds({
            ids: prev[pinning] ?? [],
            sourceId,
            targetId,
            edge,
          }),
        }));
        return;
      }

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
          stellaToast.add({
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
            lastColumnDropPosition.current = null;
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
    setVerticalScrollbarWidth(getVerticalScrollbarWidth(element));

    const resizeObserver = new ResizeObserver(() => {
      setWrapperWidth(element.clientWidth);
      setVerticalScrollbarWidth(getVerticalScrollbarWidth(element));
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
    <div
      className={cn(
        "relative h-full flex-1",
        addPropertyColumn && ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME,
      )}
    >
      <div className="h-full overflow-auto" ref={tableWrapperRef}>
        <div
          aria-colcount={visibleColumnCount}
          aria-rowcount={rowModel.rows.length}
          className="relative flex min-h-full flex-col text-sm"
          role="grid"
          style={gridStyle}
        >
          <div className="bg-background sticky top-0 z-30">
            {table.getHeaderGroups().map((headerGroup) => (
              <WorkspaceGridRow key={headerGroup.id}>
                {getOrderedHeaders(headerGroup.headers, renderColumns).map(
                  (header, index) => (
                    <DraggableHeaderCell
                      expandedColumnId={expandedTableCell?.columnId ?? null}
                      header={header}
                      index={index}
                      key={header.id}
                      onToggleSelectAll={handleToggleSelectAll}
                      selectAllState={selectAllState}
                    />
                  ),
                )}
                <HeaderEndFillerCell
                  addPropertyColumn={addPropertyColumn}
                  renderColumns={renderColumns}
                />
                {addPropertyColumn && (
                  <DraggableHeaderCell
                    expandedColumnId={expandedTableCell?.columnId ?? null}
                    header={getRequiredHeader(
                      headerGroup.headers,
                      addPropertyColumn.id,
                    )}
                    index={renderColumns.length}
                    onToggleSelectAll={handleToggleSelectAll}
                    selectAllState={selectAllState}
                  />
                )}
              </WorkspaceGridRow>
            ))}
          </div>
          <div className="flex flex-1 flex-col">
            {paddingTop > 0 && (
              <WorkspaceGridRow className="pointer-events-none">
                <WorkspaceGridFillerCell
                  className="border-b-0"
                  style={{
                    gridColumn: addPropertyColumn ? "1 / -2" : "1 / -1",
                    height: paddingTop,
                  }}
                />
                {addPropertyColumn && (
                  <AddPropertyRailSpacer height={paddingTop} />
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
                  activePropertyId={activePropertyId}
                  activeTaskId={activeTaskId}
                  editingEntityId={editingEntityId}
                  expandedCellId={
                    expandedTableCell?.entityId === row.original.entityId
                      ? expandedTableCell.columnId
                      : null
                  }
                  contentMode={contentMode}
                  hasExpandedTableCell={expandedTableCell !== null}
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
                  onToggleExpandedCell={(entityId, columnId, mode) => {
                    setExpandedTableCell((current) => {
                      if (
                        current?.entityId === entityId &&
                        current.columnId === columnId
                      ) {
                        if (mode === "open") {
                          return current;
                        }

                        return null;
                      }

                      return { entityId, columnId };
                    });
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
              <WorkspaceGridRow className="pointer-events-none">
                <WorkspaceGridFillerCell
                  className="border-b-0"
                  style={{
                    gridColumn: addPropertyColumn ? "1 / -2" : "1 / -1",
                    height: paddingBottom,
                  }}
                />
                {addPropertyColumn && (
                  <AddPropertyRailSpacer height={paddingBottom} />
                )}
              </WorkspaceGridRow>
            )}
            <TableEndFiller
              addPropertyColumn={addPropertyColumn}
              renderColumns={renderColumns}
            />
            <BottomRow
              table={table}
              onFolderCreated={setEditingEntityId}
              workspaceId={workspaceId}
            />
          </div>
        </div>
      </div>
      {addPropertyColumn && (
        <div
          className="absolute top-0 bottom-12 z-40 w-12"
          style={{ right: verticalScrollbarWidth }}
        >
          <CreateProperty triggerVariant="rail" workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
};

type TableEndFillerProps = {
  renderColumns: Column<TableTreeNode>[];
  addPropertyColumn: Column<TableTreeNode> | null;
};

const TableEndFiller = ({
  renderColumns,
  addPropertyColumn,
}: TableEndFillerProps) => (
  <WorkspaceGridRow className="pointer-events-none min-h-0 flex-1">
    {renderColumns.map((column, index) => (
      <WorkspaceGridCell
        className={cn(
          "border-b-0",
          isPinnedBoundaryColumn(column) && "border-e-0",
        )}
        key={column.id}
        role="presentation"
        style={{
          gridColumn: index + 1,
          ...getGridPinningStyles(column),
          ...tableEndFillerCellStyle,
        }}
      >
        <PinnedBoundary column={column} />
      </WorkspaceGridCell>
    ))}
    <WorkspaceGridCell
      className={cn("border-b-0 p-0", addPropertyColumn && "border-e-0")}
      role="presentation"
      style={{
        gridColumn: getEndFillerGridColumn({
          renderColumns,
          addPropertyColumn,
        }),
        ...tableEndFillerCellStyle,
      }}
    />
    {addPropertyColumn && (
      <WorkspaceGridCell
        className="border-s-2 border-e-2 border-b-0 p-0"
        data-add-property-surface
        style={{
          ...getGridPinningStyles(addPropertyColumn),
          ...tableEndFillerCellStyle,
        }}
      />
    )}
  </WorkspaceGridRow>
);

const HeaderEndFillerCell = ({
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

type RowEndFillerCellProps = EndFillerInput & {
  selected: boolean;
};

const RowEndFillerCell = ({
  renderColumns,
  addPropertyColumn,
  selected,
}: RowEndFillerCellProps) => (
  <WorkspaceGridCell
    aria-hidden="true"
    className={cn("p-0", addPropertyColumn && "border-e-0")}
    data-state={selected ? "selected" : undefined}
    role="presentation"
    style={{
      gridColumn: getEndFillerGridColumn({
        renderColumns,
        addPropertyColumn,
      }),
    }}
  />
);

type DraggableHeaderCellProps = {
  header: Header<TableTreeNode, unknown>;
  index: number;
  collapseEndBorder?: boolean;
  expandedColumnId: string | null;
  onToggleSelectAll: () => void;
  selectAllState: SelectAllState;
};

const DraggableHeaderCell = ({
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

function getWorkspaceGridTemplateColumns({
  renderColumns,
  addPropertyColumn,
}: EndFillerInput) {
  const contentColumns = getGridTemplateColumns(renderColumns);
  if (addPropertyColumn) {
    return `${contentColumns} minmax(0, 1fr) ${addPropertyColumn.getSize()}px`;
  }

  return `${contentColumns} minmax(0, 1fr)`;
}

function getEndFillerGridColumn({
  renderColumns,
  addPropertyColumn,
}: EndFillerInput) {
  return `${renderColumns.length + 1} / ${addPropertyColumn ? "-2" : "-1"}`;
}

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

const isPinnedBoundaryColumn = (column: Column<TableTreeNode>) =>
  column.getIsPinned() === "left" && column.getIsLastColumn("left");

const PinnedBoundary = ({ column }: PinnedBoundaryProps) => {
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

  if (target.closest("[data-open-expanded-cell]")) {
    return false;
  }

  return Boolean(
    target.closest(
      "button, a, input, textarea, select, [role='button'], [role='checkbox'], [data-row-expansion-ignore], [data-slot='select-trigger']",
    ),
  );
};

const getContextPropertyId = (target: EventTarget) => {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  return (
    target.closest<HTMLElement>("[data-table-property-id]")?.dataset[
      "tablePropertyId"
    ] ?? null
  );
};

type ActiveCellFlashInput = {
  activeCellPropertyId: string | null;
  activationSeq: number;
  rowRef: React.RefObject<HTMLDivElement | null>;
  visibleCells: Cell<TableTreeNode, unknown>[];
};

const useActiveCellFlash = ({
  activeCellPropertyId,
  activationSeq,
  rowRef,
  visibleCells,
}: ActiveCellFlashInput) => {
  const previousCellActivationSeq = useRef(activationSeq);

  useEffect(() => {
    const rowElement = rowRef.current;
    if (
      !rowElement ||
      !activeCellPropertyId ||
      activationSeq === previousCellActivationSeq.current
    ) {
      previousCellActivationSeq.current = activationSeq;
      return;
    }

    const cellIndex = visibleCells.findIndex(
      (cell) => cell.column.id === activeCellPropertyId,
    );
    const cellElement = rowElement.children.item(cellIndex);
    if (!(cellElement instanceof HTMLElement)) {
      previousCellActivationSeq.current = activationSeq;
      return;
    }

    cellElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const c = "var(--color-primary)";
    const t = "transparent";
    cellElement.animate(
      [
        { boxShadow: `inset 0 0 0 2px ${c}` },
        { boxShadow: `inset 0 0 0 2px ${t}` },
      ],
      { duration: 500, easing: "ease-out" },
    );
    previousCellActivationSeq.current = activationSeq;
  }, [activationSeq, activeCellPropertyId, rowRef, visibleCells]);
};

type ActiveRowInput = {
  activeCellPropertyId: string | null;
  activeEntityId: string | null;
  activeTaskId: string | null;
  entityId: string;
};

const isActiveRow = ({
  activeCellPropertyId,
  activeEntityId,
  activeTaskId,
  entityId,
}: ActiveRowInput) =>
  entityId === activeTaskId ||
  (entityId === activeEntityId && activeCellPropertyId === null);

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
  activePropertyId: string | null;
  activeTaskId: string | null;
  contentMode: TableContentMode;
  editingEntityId: string | null;
  expandedCellId: string | null;
  hasExpandedTableCell: boolean;
  lastSelectedIndex: React.RefObject<number | null>;
  measureElement: (element: Element | null) => void;
  onRename: (entityId: string, newName: string) => void;
  onStartEditing: (entityId: string) => void;
  onStopEditing: () => void;
  onToggleExpandedCell: (
    entityId: string,
    columnId: string,
    mode?: "toggle" | "open",
  ) => void;
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
  activePropertyId,
  activeTaskId,
  contentMode,
  editingEntityId,
  expandedCellId,
  hasExpandedTableCell,
  lastSelectedIndex,
  measureElement,
  onRename,
  onStartEditing,
  onStopEditing,
  onToggleExpandedCell,
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
  const [contextPropertyId, setContextPropertyId] = useState<string | null>(
    null,
  );
  const entity = row.original;
  const isFolder = entity.kind === "folder";
  const isTask = entity.kind === "task";
  const isFocusedExpansionRow = expandedCellId !== null;
  const isMutedByExpandedCell = hasExpandedTableCell && !isFocusedExpansionRow;
  const visibleCells = getOrderedCells(row.getVisibleCells(), renderColumns);
  const addPropertyCell = addPropertyColumn
    ? row
        .getVisibleCells()
        .find((cell) => cell.column.id === addPropertyColumn.id)
    : undefined;
  const name = getEntityName(entity);
  const file = getFirstFile(entity);
  const activeCellPropertyId =
    entity.entityId === activeEntityId ? activePropertyId : null;
  const activeRow = isActiveRow({
    activeCellPropertyId,
    activeEntityId,
    activeTaskId,
    entityId: entity.entityId,
  });
  const activationSeq = useInspectorStore((s) => s.activationSeq);

  useInspectorFlash(entity.entityId, rowRef, {
    enabled: activeCellPropertyId === null,
  });
  useActiveCellFlash({
    activeCellPropertyId,
    activationSeq,
    rowRef,
    visibleCells,
  });

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
    setContextPropertyId(getContextPropertyId(e.target));
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0),
    });
    setContextOpen(true);
  };

  const handleRowClick = (e: React.MouseEvent) => {
    if (!isTask || shouldIgnoreRowExpansionClick(e.target)) {
      return;
    }

    useInspectorStore.getState().openTask(entity.entityId, name);
  };

  const toggleExpandedCell = (columnId: string, mode?: "toggle" | "open") => {
    onToggleExpandedCell(entity.entityId, columnId, mode);
  };

  const handleCellClick = (
    event: React.MouseEvent,
    columnId: string,
    canExpandCell: boolean,
  ) => {
    if (!canExpandCell || shouldIgnoreRowExpansionClick(event.target)) {
      return;
    }

    event.stopPropagation();
    toggleExpandedCell(
      columnId,
      event.target instanceof Element &&
        event.target.closest("[data-open-expanded-cell]")
        ? "open"
        : "toggle",
    );
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
          setContextPropertyId(null);
          bulkEntitiesRef.current = undefined;
        }
      }}
      onRename={isFolder ? () => onStartEditing(entity.entityId) : undefined}
      open={contextOpen}
      selectedEntities={contextOpen ? bulkEntitiesRef.current : undefined}
      cellMetadataTarget={
        contextPropertyId
          ? {
              propertyId: contextPropertyId,
              metadata: entity.cellMetadata[contextPropertyId],
            }
          : null
      }
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
  }, [contentMode, expandedCellId, measureElement]);

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
    return (
      <FolderTableRow
        activeEntityId={activeEntityId}
        addPropertyCell={addPropertyCell}
        editingEntityId={editingEntityId}
        entity={entity}
        isMutedByExpandedCell={isMutedByExpandedCell}
        onContextMenu={handleContextMenu}
        onRename={onRename}
        onStartEditing={onStartEditing}
        onStopEditing={onStopEditing}
        ref={setRowRef}
        renderColumns={renderColumns}
        row={row}
        selectCellWithActions={selectCellWithActions}
        virtualIndex={virtualIndex}
        visibleCells={visibleCells}
      />
    );
  }

  return (
    <WorkspaceGridRow
      aria-rowindex={virtualIndex + 2}
      aria-selected={row.getIsSelected()}
      className={cn(
        "transition-opacity duration-150",
        contentMode === "tight" && TOOLBAR_ROW_HEIGHT,
        isTask && "cursor-pointer",
        isFocusedExpansionRow && "relative z-20",
        isMutedByExpandedCell && "opacity-[0.92] hover:opacity-100",
      )}
      data-active={activeRow || undefined}
      data-index={virtualIndex}
      data-state={row.getIsSelected() ? "selected" : undefined}
      key={row.id}
      onClick={handleRowClick}
      onContextMenu={handleContextMenu}
      ref={setRowRef}
    >
      <DataRowCells
        expandedCellId={expandedCellId}
        contentMode={contentMode}
        hasExpandedCell={isFocusedExpansionRow}
        onCellClick={handleCellClick}
        selectCellWithActions={selectCellWithActions}
        visibleCells={visibleCells}
      />
      <RowEndFillerCell
        addPropertyColumn={addPropertyColumn}
        renderColumns={renderColumns}
        selected={row.getIsSelected()}
      />
      <AddPropertyCell
        cell={addPropertyCell}
        columnIndex={renderColumns.length + 1}
        selected={row.getIsSelected()}
      />
    </WorkspaceGridRow>
  );
};

type FolderTableRowProps = {
  activeEntityId: string | null;
  addPropertyCell: Cell<TableTreeNode, unknown> | undefined;
  editingEntityId: string | null;
  entity: TableTreeNode;
  isMutedByExpandedCell: boolean;
  onContextMenu: (event: React.MouseEvent) => void;
  onRename: (entityId: string, newName: string) => void;
  onStartEditing: (entityId: string) => void;
  onStopEditing: () => void;
  ref: (element: HTMLDivElement | null) => void;
  renderColumns: Column<TableTreeNode>[];
  row: Row<TableTreeNode>;
  selectCellWithActions: React.ReactNode;
  virtualIndex: number;
  visibleCells: Cell<TableTreeNode, unknown>[];
};

const FolderTableRow = ({
  activeEntityId,
  addPropertyCell,
  editingEntityId,
  entity,
  isMutedByExpandedCell,
  onContextMenu,
  onRename,
  onStartEditing,
  onStopEditing,
  ref,
  renderColumns,
  row,
  selectCellWithActions,
  virtualIndex,
  visibleCells,
}: FolderTableRowProps) => {
  const selectCell = visibleCells[0];
  const nameCell = visibleCells[1];
  if (!selectCell || !nameCell) {
    return null;
  }

  return (
    <WorkspaceGridRow
      aria-rowindex={virtualIndex + 2}
      aria-selected={row.getIsSelected()}
      className={cn(
        "transition-opacity duration-150",
        TOOLBAR_ROW_HEIGHT,
        isMutedByExpandedCell && "opacity-[0.92] hover:opacity-100",
      )}
      data-active={entity.entityId === activeEntityId || undefined}
      data-index={virtualIndex}
      data-state={row.getIsSelected() ? "selected" : undefined}
      key={row.id}
      onContextMenu={onContextMenu}
      ref={ref}
    >
      <WorkspaceGridCell
        aria-colindex={1}
        className={cn(
          isPinnedBoundaryColumn(selectCell.column) && "border-e-0",
        )}
        data-state={row.getIsSelected() ? "selected" : undefined}
        key={selectCell.id}
        style={{
          gridColumn: 1,
          ...getGridPinningStyles(selectCell.column),
        }}
      >
        <PinnedBoundary column={selectCell.column} />
        {selectCellWithActions}
      </WorkspaceGridCell>
      <WorkspaceGridCell
        aria-colindex={2}
        className={cn(
          "cursor-pointer",
          isPinnedBoundaryColumn(nameCell.column) && "border-e-0",
        )}
        data-state={row.getIsSelected() ? "selected" : undefined}
        key={nameCell.id}
        onClick={() => row.toggleExpanded()}
        style={{
          gridColumn: 2,
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
      <AddPropertyCell
        cell={addPropertyCell}
        columnIndex={renderColumns.length + 1}
        selected={row.getIsSelected()}
      />
    </WorkspaceGridRow>
  );
};

type DataRowCellsProps = {
  expandedCellId: string | null;
  contentMode: TableContentMode;
  hasExpandedCell: boolean;
  onCellClick: (
    event: React.MouseEvent,
    columnId: string,
    canExpandCell: boolean,
  ) => void;
  selectCellWithActions: React.ReactNode;
  visibleCells: Cell<TableTreeNode, unknown>[];
};

const DataRowCells = ({
  expandedCellId,
  contentMode,
  hasExpandedCell,
  onCellClick,
  selectCellWithActions,
  visibleCells,
}: DataRowCellsProps) =>
  visibleCells.map((cell, cellIndex) => {
    const isSelectCell = cell.column.id === selectColId;
    const isAddPropertyCell = cell.column.id === addPropertyColId;
    const canExpandCell = !isSelectCell && !isAddPropertyCell;
    const canFlagCell = canExpandCell && !cell.column.id.startsWith("_");
    const isExpandedCell = expandedCellId === cell.column.id;
    const fieldContent = cell.row.original.fields[cell.column.id]?.content;
    const isExpandedTextCell = isExpandedCell && fieldContent?.type === "text";

    return (
      <WorkspaceGridCell
        aria-colindex={cellIndex + 1}
        className={cn(
          "relative",
          canExpandCell && "cursor-pointer",
          isSelectCell && "min-w-12 shrink-0",
          isPinnedBoundaryColumn(cell.column) && "border-e-0",
          cell.column.columnDef.meta?.muted && "text-muted-foreground",
          contentMode === "fit-content" &&
            "whitespace-normal! [&_.line-clamp-2]:line-clamp-none [&_.truncate]:min-w-0 [&_.truncate]:overflow-visible [&_.truncate]:wrap-break-word [&_.truncate]:whitespace-normal",
          hasExpandedCell &&
            !isExpandedCell &&
            !isSelectCell &&
            "opacity-90 transition-opacity duration-150",
          isExpandedCell &&
            "z-30 overflow-visible! whitespace-normal! [&_.line-clamp-2]:line-clamp-none [&_.truncate]:min-w-0 [&_.truncate]:overflow-visible [&_.truncate]:wrap-break-word [&_.truncate]:whitespace-normal",
          cell.column.getIsResizing() &&
            "after:bg-info after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-50 after:w-px",
        )}
        data-expanded-cell={isExpandedCell || undefined}
        data-state={cell.row.getIsSelected() ? "selected" : undefined}
        data-table-property-id={canFlagCell ? cell.column.id : undefined}
        key={cell.id}
        onClick={(event) => onCellClick(event, cell.column.id, canExpandCell)}
        style={{
          gridColumn: cellIndex + 1,
          ...getGridPinningStyles(cell.column),
        }}
      >
        <PinnedBoundary column={cell.column} />
        {isSelectCell ? (
          selectCellWithActions
        ) : (
          <span
            className={cn(
              "flex w-full min-w-0 items-center gap-1.5",
              (contentMode === "fit-content" || isExpandedTextCell) &&
                "items-start",
              isExpandedCell &&
                "border-border/80 bg-background absolute inset-x-0 top-0 z-40 max-h-96 min-h-24 items-start overflow-y-auto border p-2 pb-8 shadow-lg",
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </span>
        )}
      </WorkspaceGridCell>
    );
  });

type AddPropertyCellProps = {
  cell: Cell<TableTreeNode, unknown> | undefined;
  columnIndex: number;
  selected: boolean;
};

const AddPropertyCell = ({
  cell,
  columnIndex,
  selected,
}: AddPropertyCellProps) => {
  if (!cell) {
    return null;
  }

  return (
    <WorkspaceGridCell
      aria-colindex={columnIndex}
      className="border-s-2 border-e-2 p-0"
      data-add-property-surface
      data-state={selected ? "selected" : undefined}
      style={{
        ...getGridPinningStyles(cell.column),
      }}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </WorkspaceGridCell>
  );
};

type AddPropertyRailSpacerProps = {
  height: number;
};

const AddPropertyRailSpacer = ({ height }: AddPropertyRailSpacerProps) => (
  <WorkspaceGridCell
    className="border-s-2 border-e-2 border-b-0 p-0"
    data-add-property-surface
    style={{
      gridColumn: "-2 / -1",
      height,
      position: "sticky",
      right: 0,
      zIndex: 2,
      ...tableEndFillerCellStyle,
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
