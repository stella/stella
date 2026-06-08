import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { BulkAddColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/bulk-add-columns";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  getNextSelectAllRowSelection,
  getSelectAllState,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/select-all.logic";
import type { WorkspaceTable as WorkspaceTableType } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridFillerCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import {
  getOrderedColumns,
  reorderColumnIds,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import type { ColumnDropEdge } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import {
  AddPropertyRailSpacer,
  TableEndFiller,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/end-fillers";
import {
  DraggableHeaderCell,
  getOrderedHeaders,
  getRequiredHeader,
  HeaderEndFillerCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/header-cells";
import {
  ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME,
  addPropertyColId,
  getColumnPinningGroup,
  getVerticalScrollbarWidth,
  getWorkspaceGridTemplateColumns,
  TABLE_COLUMN_DRAG_TYPE,
  TABLE_ROW_ESTIMATE_PX,
  TABLE_ROW_OVERSCAN,
  toColumnDropEdge,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import type {
  ColumnDropPosition,
  ExpandedTableCell,
  WorkspaceGridStyle,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import { DraggableRow } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/row-cells";
import type { TableContentMode } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { countDescendants } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type WorkspaceTableProps = {
  workspaceId: string;
  table: WorkspaceTableType;
  contentMode: TableContentMode;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
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
    rowSelection: table.state.rowSelection,
  });
  const handleToggleSelectAll = useCallback(() => {
    table.setRowSelection(
      getNextSelectAllRowSelection({
        selectableRowIds,
        rowSelection: table.state.rowSelection,
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
            ids: prev[pinning],
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
          <BulkAddColumns triggerVariant="rail" workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
};
