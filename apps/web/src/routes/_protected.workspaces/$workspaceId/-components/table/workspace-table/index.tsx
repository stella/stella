import {
  type RefObject,
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

import { useExternalSyncEffect } from "@/hooks/use-effect";
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
  getScrollableAncestor,
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
  // Grouped sections opt out so the "+ new document" row isn't repeated
  // under every group.
  showAddRow?: boolean;
  // Grouped sections opt out: the group header already sticks to the page,
  // and a second sticky header in each section's own scroll box collides
  // with it on scroll.
  stickyColumnHeader?: boolean;
  // The end-filler grows to fill leftover height (and hosts the add-property
  // rail) in the full-height flat table. Grouped sections size to content, so
  // a growing filler just shows as an empty trailing row.
  fillHeight?: boolean;
  // When set, the table flows inside this shared scroll container instead of
  // owning its own scroll box. Grouped sections pass the single grouped-view
  // scroller so every group shares one vertical/horizontal scroll (nested
  // scroll boxes break the sticky group header). In this mode rows render
  // directly rather than virtualized — group pages are bounded.
  outerScrollRef?: RefObject<HTMLDivElement | null>;
  // Union of every section's row ids, so a grouped section's select-all keeps
  // selections in other sections (they share one selection) while still dropping
  // stale ids. Omitted by the flat table.
  selectAllPreservableRowIds?: () => string[];
};

// A grouped section virtualizes against a shared ancestor scroll it does not
// own, so it must never drive that scroll. TanStack Virtual otherwise
// compensates for `scrollMargin` changing from its initial 0 to the measured
// offset by calling `scrollToOffset` on mount — which yanks the whole grouped
// view to the top. A no-op `scrollToFn` keeps the section a pure reader of the
// scroll it shares. (The flat table owns its scroll and keeps the default.)
const noopScrollTo = () => undefined;

// eslint-disable-next-line react/react-compiler -- react-compiler skips this component: an API it uses returns functions that cannot be memoized, so the compiler bails out of the whole component (Compilation Skipped: incompatible library)
export const WorkspaceTable = ({
  workspaceId,
  table,
  contentMode,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  showAddRow = true,
  stickyColumnHeader = true,
  fillHeight = true,
  outerScrollRef,
  selectAllPreservableRowIds,
}: WorkspaceTableProps) => {
  const inlineFlow = outerScrollRef !== undefined;
  const t = useTranslations();
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndex = useRef<number | null>(null);
  const previousHorizontalMaxScroll = useRef<number | null>(null);
  const lastColumnDropPosition = useRef<ColumnDropPosition | null>(null);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const [expandedTableCell, setExpandedTableCell] =
    useState<ExpandedTableCell | null>(null);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const [verticalScrollbarWidth, setVerticalScrollbarWidth] = useState(0);
  // Offset of this section's rows within the shared grouped scroll, so the
  // virtualizer windows the right rows. Stays 0 for the flat table (it owns its
  // own scroll); measured + kept current by the effect below for grouped.
  const rowsContainerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const updateWrapperWidth = useCallback((nextWrapperWidth: number) => {
    setWrapperWidth((current) =>
      current === nextWrapperWidth ? current : nextWrapperWidth,
    );
  }, []);

  const updateVerticalScrollbarWidth = useCallback(
    (nextVerticalScrollbarWidth: number) => {
      setVerticalScrollbarWidth((current) =>
        current === nextVerticalScrollbarWidth
          ? current
          : nextVerticalScrollbarWidth,
      );
    },
    [],
  );

  useExternalSyncEffect(() => {
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
    // Read the latest cross-group row-id union at click time from the
    // getter, so this table never re-renders as that union grows during load.
    const preservableRowIds = selectAllPreservableRowIds?.();
    table.setRowSelection(
      getNextSelectAllRowSelection({
        selectableRowIds,
        rowSelection: table.state.rowSelection,
        ...(preservableRowIds && { preservableRowIds }),
      }),
    );
  }, [selectableRowIds, selectAllPreservableRowIds, table]);

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
    getScrollElement: () => {
      if (!inlineFlow) {
        return tableWrapperRef.current;
      }
      // Grouped sections virtualize against the shared ancestor scroll, not
      // their own (non-scrolling) wrapper.
      const wrapper = tableWrapperRef.current;
      return wrapper ? getScrollableAncestor(wrapper) : null;
    },
    estimateSize: () => TABLE_ROW_ESTIMATE_PX,
    getItemKey: getVirtualRowKey,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: TABLE_ROW_OVERSCAN,
    scrollMargin: inlineFlow ? scrollMargin : 0,
    ...(inlineFlow && { scrollToFn: noopScrollTo }),
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastVirtualRow = virtualRows.at(-1);
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- infinite-load trigger that must also re-fire when isFetchingNextPage/hasNextPage flip (not only on virtualizer changes), so it can chain the next page while still parked at the bottom; a virtualizer onChange handler would miss that path, so kept
  useEffect(() => {
    // Inline (grouped) sections de-virtualize their rows into a non-scrolling
    // wrapper, so the virtualizer treats every row as visible and would fetch
    // every page at once. Those sections page via the intersection sentinel
    // below instead.
    if (
      inlineFlow ||
      !hasNextPage ||
      isFetchingNextPage ||
      !onLoadMore ||
      !lastVirtualRow
    ) {
      return;
    }

    const shouldLoadMore =
      lastVirtualRow.index >= rowModel.rows.length - 1 - TABLE_ROW_OVERSCAN;
    if (shouldLoadMore) {
      onLoadMore();
    }
  }, [
    inlineFlow,
    hasNextPage,
    isFetchingNextPage,
    lastVirtualRow,
    onLoadMore,
    rowModel.rows.length,
  ]);
  useExternalSyncEffect(() => {
    // Bounded paging for inline sections: only fetch the next page when the
    // sentinel at the end of the rendered rows actually scrolls into the real
    // scroll viewport. That viewport is an ancestor `overflow-auto` element, not
    // the non-scrolling content wrapper passed as `outerScrollRef`, so resolve
    // it from the sentinel itself (null falls back to the browser viewport).
    const sentinel = loadMoreSentinelRef.current;
    if (!inlineFlow || !hasNextPage || !onLoadMore || !sentinel) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          !isFetchingNextPage
        ) {
          onLoadMore();
        }
      },
      { root: getScrollableAncestor(sentinel), rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [inlineFlow, hasNextPage, isFetchingNextPage, onLoadMore]);
  // Grouped sections share one scroll, so each virtualizes its rows against it.
  // `scrollMargin` is this section's row offset within the scroll content; it is
  // scroll-invariant, so we re-measure on layout changes (other groups loading
  // or collapsing shift this section's offset), not on scroll.
  useExternalSyncEffect(() => {
    const rowsContainer = rowsContainerRef.current;
    const content = outerScrollRef?.current;
    if (!inlineFlow || !rowsContainer || !content) {
      return undefined;
    }
    const scrollEl = getScrollableAncestor(rowsContainer);
    if (!scrollEl) {
      return undefined;
    }
    const measure = () => {
      const margin =
        rowsContainer.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop;
      // Dead-band: ignore sub-row jitter so a settling measurement can't drive a
      // measure -> re-render -> re-measure cycle.
      setScrollMargin((previous) =>
        Math.abs(previous - margin) < 4 ? previous : margin,
      );
    };
    // Debounce through a frame: as rows settle the ResizeObserver fires in a
    // burst; coalescing into one post-layout measurement breaks the feedback
    // loop (measure -> setScrollMargin -> re-window -> resize -> measure) that
    // would otherwise re-render-storm and re-mount the route while scrolling.
    let frame = 0;
    let scheduled = false;
    const scheduleMeasure = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      frame = requestAnimationFrame(() => {
        scheduled = false;
        measure();
      });
    };
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(content);
    observer.observe(scrollEl);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [inlineFlow, outerScrollRef]);
  // `virtualItem.start` is measured from the scroll start and includes the
  // scrollMargin, while the rows container already sits at scrollMargin in the
  // DOM flow — so subtract it for the top filler and add it back for the bottom
  // filler. Both reduce to the plain formulas when scrollMargin is 0 (flat).
  const virtualizerScrollMargin = rowVirtualizer.options.scrollMargin;
  const paddingTop = (virtualRows.at(0)?.start ?? 0) - virtualizerScrollMargin;
  const paddingBottom =
    rowVirtualizer.getTotalSize() -
    (virtualRows.at(-1)?.end ?? 0) +
    virtualizerScrollMargin;
  // Every layout windows its rows now; grouped sections virtualize against the
  // shared scroll via scrollMargin (above), the flat table against its wrapper.
  const renderedRows = virtualRows.map((virtualRow) => ({
    row: rowModel.rows.at(virtualRow.index),
    index: virtualRow.index,
  }));
  const orderedColumns = getOrderedColumns({
    leftColumns: table.getLeftLeafColumns(),
    centerColumns: table.getCenterLeafColumns(),
    rightColumns: table.getRightLeafColumns(),
  }).filter((column) => column.getIsVisible());
  // Grouped sections drop the per-group add-column rail: it would repeat under
  // every group and the toolbar already offers "+ new column". (Its trigger is
  // absolute-positioned, so it also wouldn't pin in the shared scroll.)
  const addPropertyColumn = inlineFlow
    ? null
    : (orderedColumns.find((column) => column.id === addPropertyColId) ?? null);
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

  useExternalSyncEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) {
      return undefined;
    }

    return combine(
      // Horizontal auto-scroll only when this table owns its scroll (flat
      // layout). In the grouped layout the table shares the outer scroller, so
      // this element is not scrollable; Atlaskit then warns on every drag tick
      // and Vite serializes the whole element into the terminal, ballooning the
      // dev log to gigabytes and OOM-killing the dev server.
      ...(fillHeight
        ? [
            autoScrollForElements({
              element,
              getAllowedAxis: () => "horizontal",
            }),
          ]
        : []),
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
  }, [handleColumnReorder, t, fillHeight]);

  useExternalSyncEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) {
      return undefined;
    }

    const updateMetrics = () => {
      const nextWrapperWidth = element.clientWidth;
      const nextVerticalScrollbarWidth = getVerticalScrollbarWidth(element);
      updateWrapperWidth(nextWrapperWidth);
      updateVerticalScrollbarWidth(nextVerticalScrollbarWidth);
    };

    updateMetrics();
    const resizeObserver = new ResizeObserver(updateMetrics);
    resizeObserver.observe(element);

    return () => resizeObserver.disconnect();
  }, [inlineFlow, updateVerticalScrollbarWidth, updateWrapperWidth]);

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
        "relative",
        !inlineFlow && "h-full flex-1",
        addPropertyColumn && ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME,
      )}
    >
      <div
        className={
          inlineFlow ? "w-full" : "scrollbar-subtle h-full overflow-auto"
        }
        ref={tableWrapperRef}
      >
        <div
          aria-colcount={visibleColumnCount}
          aria-rowcount={rowModel.rows.length}
          className={cn(
            "relative flex flex-col text-sm",
            !inlineFlow && "min-h-full",
          )}
          role="grid"
          style={gridStyle}
        >
          <div
            className={cn(
              "bg-background z-30",
              stickyColumnHeader && "sticky top-0",
            )}
          >
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
          <div className="flex flex-1 flex-col" ref={rowsContainerRef}>
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
            {renderedRows.map(({ row, index }) => {
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
                  index={index}
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
                  rowLabel={rowLabels[index] ?? ""}
                  renderColumns={renderColumns}
                  table={table}
                  virtualIndex={index}
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
            {/* Below the bottom spacer so it marks the section's true end, not
                the windowed end — otherwise the virtualized window keeps it near
                the viewport and would page every group at once. */}
            {inlineFlow && hasNextPage && (
              <div
                aria-hidden
                className="pointer-events-none h-px"
                ref={loadMoreSentinelRef}
                style={{ gridColumn: "1 / -1" }}
              />
            )}
            {fillHeight && (
              <TableEndFiller
                addPropertyColumn={addPropertyColumn}
                renderColumns={renderColumns}
              />
            )}
            {showAddRow && (
              <BottomRow
                table={table}
                onFolderCreated={setEditingEntityId}
                workspaceId={workspaceId}
              />
            )}
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
