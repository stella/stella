import {
  Fragment,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@stll/ui/utils";

import {
  addColumnHeaderCellStyle,
  addColumnRailStyle,
} from "@/components/workspaces/table/add-column-rail";
import type { TableRowHost } from "@/components/workspaces/table/row-host";
import {
  getNextSelectAllRowSelection,
  getSelectAllState,
} from "@/components/workspaces/table/select-all.logic";
import type {
  TableRowData,
  TableTreeNode,
  WorkspaceTable as WorkspaceTableType,
} from "@/components/workspaces/table/types";
import {
  WorkspaceGridFillerCell,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import {
  getOrderedColumns,
  reorderColumnIds,
} from "@/components/workspaces/table/workspace-grid-order";
import type { ColumnDropEdge } from "@/components/workspaces/table/workspace-grid-order";
import {
  AddPropertyRailSpacer,
  TableEndFiller,
} from "@/components/workspaces/table/workspace-table/end-fillers";
import {
  DraggableHeaderCell,
  HeaderEndFillerCell,
} from "@/components/workspaces/table/workspace-table/header-cells";
import { anchoredHorizontalScroll } from "@/components/workspaces/table/workspace-table/horizontal-scroll.logic";
import type { HorizontalScrollMetrics } from "@/components/workspaces/table/workspace-table/horizontal-scroll.logic";
import {
  ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME,
  TABLE_ROW_ESTIMATE_PX,
  TABLE_ROW_OVERSCAN,
} from "@/components/workspaces/table/workspace-table/internals";
import type {
  ColumnDropPosition,
  ExpandedTableCell,
  WorkspaceGridStyle,
} from "@/components/workspaces/table/workspace-table/internals";
import {
  addPropertyColId,
  getColumnPinningGroup,
  getOrderedHeaders,
  getRequiredHeader,
  getScrollableAncestor,
  getVerticalScrollbarWidth,
  getWorkspaceGridTemplateColumns,
  TABLE_COLUMN_DRAG_TYPE,
  toColumnDropEdge,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import { tableRowWindow } from "@/components/workspaces/table/workspace-table/row-window.logic";
import { WorkspaceTableSkeletonRows } from "@/components/workspaces/table/workspace-table/skeleton-rows";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";
import type { TableContentMode } from "@/lib/workspaces/table-store";

type WorkspaceTableProps<TRow extends TableRowData> = {
  table: WorkspaceTableType<TRow>;
  /**
   * The number the first row carries. A paged list hands in the first
   * ordinal of its page, so page three does not count from one again.
   */
  firstRowNumber?: number;
  /** Everything that depends on what a row is; see `TableRowHost`. */
  rowHost: TableRowHost<TRow>;
  contentMode: TableContentMode;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  // Placeholder rows for a body with nothing in it yet, drawn in this table's
  // own grid. 0 leaves the body empty, which is what a table with no rows to
  // wait for shows.
  skeletonRowCount?: number;
  // Grouped sections opt out: the group header already sticks to the page,
  // and a second sticky header in each section's own scroll box collides
  // with it on scroll.
  stickyColumnHeader?: boolean;
  // The end-filler grows to fill leftover height (and carries the
  // add-property surface down the page) in the full-height flat table. A table
  // that sizes to its content draws it as one empty bordered row under the
  // last result instead, so grouped sections and the public results list opt
  // out. The add-column rail is drawn beside the table either way.
  fillHeight?: boolean;
  // When set, the table flows inside this shared scroll container instead of
  // owning its own scroll box. Grouped sections pass the single grouped-view
  // scroller so every group shares one vertical/horizontal scroll (nested
  // scroll boxes break the sticky group header). In this mode rows render
  // directly rather than virtualized — group pages are bounded.
  outerScrollRef?: RefObject<HTMLDivElement | null>;
};

// A grouped section virtualizes against a shared ancestor scroll it does not
// own, so it must never drive that scroll. TanStack Virtual otherwise
// compensates for `scrollMargin` changing from its initial 0 to the measured
// offset by calling `scrollToOffset` on mount — which yanks the whole grouped
// view to the top. A no-op `scrollToFn` keeps the section a pure reader of the
// scroll it shares. (The flat table owns its scroll and keeps the default.)
const noopScrollTo = () => undefined;

export const WorkspaceTable = <TRow extends TableRowData = TableTreeNode>({
  table,
  rowHost,
  contentMode,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  skeletonRowCount = 0,
  stickyColumnHeader = true,
  fillHeight = true,
  firstRowNumber = 1,
  outerScrollRef,
}: WorkspaceTableProps<TRow>) => {
  const inlineFlow = outerScrollRef !== undefined;
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const headerRowsRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndex = useRef<number | null>(null);
  const previousScrollMetrics = useRef<HorizontalScrollMetrics | null>(null);
  const lastColumnDropPosition = useRef<ColumnDropPosition | null>(null);
  const [expandedTableCell, setExpandedTableCell] =
    useState<ExpandedTableCell | null>(null);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const [verticalScrollbarWidth, setVerticalScrollbarWidth] = useState(0);
  // What the rail's "+" centres on. Starts at the height the header cells
  // carry as a class and then follows what this table's header row measures:
  // a header that wraps or stacks is taller than one line of text.
  const [headerHeight, setHeaderHeight] = useState<number>(
    TOOLBAR_ROW_HEIGHT_PX,
  );
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

  const updateHeaderHeight = useCallback((nextHeaderHeight: number) => {
    setHeaderHeight((current) =>
      current === nextHeaderHeight ? current : nextHeaderHeight,
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

  const handleToggleExpandedCell = useCallback(
    (rowId: string, columnId: string, mode?: "toggle" | "open") => {
      setExpandedTableCell((current) => {
        if (current?.rowId === rowId && current.columnId === columnId) {
          return mode === "open" ? current : null;
        }

        return { rowId, columnId };
      });
    },
    [],
  );

  const rowModel = table.getRowModel();
  const selectableRowIds = useMemo(() => {
    const ids: string[] = [];
    for (const row of rowModel.rows) {
      if (row.getCanSelect()) {
        ids.push(row.id);
      }
    }
    return ids;
  }, [rowModel.rows]);
  const selectAllState = getSelectAllState({
    selectableRowIds,
    rowSelection: table.state.rowSelection,
  });
  const getPreservableRowIds = rowHost.preservableRowIds;
  const handleToggleSelectAll = useCallback(() => {
    // The host reads its union at click time rather than handing it over on
    // every render, so this table never re-renders as that union grows.
    const preservableRowIds = getPreservableRowIds?.();
    table.setRowSelection(
      getNextSelectAllRowSelection({
        selectableRowIds,
        rowSelection: table.state.rowSelection,
        ...(preservableRowIds && { preservableRowIds }),
      }),
    );
  }, [getPreservableRowIds, selectableRowIds, table]);

  const collapsedRowSpan = rowHost.collapsedRowSpan;
  const rowLabels = useMemo(() => {
    // Compute logical row labels that account for the rows a collapsed row
    // hides. Each visible row gets a 1-based number; a collapsed row standing
    // for others shows a range.
    const labels: string[] = [];
    let logicalPos = firstRowNumber;
    for (const row of rowModel.rows) {
      const hiddenCount = row.getIsExpanded()
        ? 0
        : (collapsedRowSpan?.(row.original) ?? 0);

      if (hiddenCount > 0) {
        labels.push(`${logicalPos}-${logicalPos + hiddenCount}`);
        logicalPos += hiddenCount + 1;
      } else {
        labels.push(String(logicalPos));
        logicalPos += 1;
      }
    }
    return labels;
  }, [collapsedRowSpan, firstRowNumber, rowModel]);
  const getVirtualRowKey = useCallback(
    (index: number) => rowModel.rows.at(index)?.id ?? `table-row-${index}`,
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
  useExternalSyncEffect(() => {
    // Only fetch when the true-end sentinel (after virtual padding) enters the
    // real scroll viewport. Rebinding after a page settles lets paging continue
    // while the user remains parked at the bottom.
    const sentinel = loadMoreSentinelRef.current;
    if (!hasNextPage || !onLoadMore || !sentinel) {
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
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);
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
  // Every layout windows its rows now; grouped sections virtualize against the
  // shared scroll via scrollMargin, the flat table against its wrapper. Until
  // one of them is measured the virtualizer has no window, and the body draws
  // its own first rows rather than none; see `row-window.logic`.
  const { indexes, paddingTop, paddingBottom } = tableRowWindow({
    virtualRows,
    rowCount: rowModel.rows.length,
    totalSize: rowVirtualizer.getTotalSize(),
    scrollMargin: rowVirtualizer.options.scrollMargin,
    estimatedRowPx: TABLE_ROW_ESTIMATE_PX,
  });
  const renderedRows = indexes.map((index) => ({
    row: rowModel.rows.at(index),
    index,
  }));
  // Rows that are on their way stand in the grid; rows that are on screen stay
  // on screen, so a refetch over a drawn result set never draws both.
  const showsSkeletonRows = skeletonRowCount > 0 && rowModel.rows.length === 0;
  const orderedColumns = getOrderedColumns({
    startColumns: table.getStartLeafColumns(),
    centerColumns: table.getCenterLeafColumns(),
    endColumns: table.getEndLeafColumns(),
  }).filter((column) => column.getIsVisible());
  const addPropertyColumn =
    orderedColumns.find((column) => column.id === addPropertyColId) ?? null;
  // A standalone table overlays one full-height rail on its own scroller.
  // Grouped sections share the outer scroll, where that absolute overlay would
  // not pin, so each section puts the trigger in its sticky header cell.
  const addColumnHeaderTrigger =
    inlineFlow && rowHost.addColumnRail !== undefined ? (
      <div style={addColumnHeaderCellStyle}>{rowHost.addColumnRail}</div>
    ) : undefined;
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
      const hiddenIds: string[] = [];
      for (const column of table.getAllLeafColumns()) {
        if (!visibleIdSet.has(column.id)) {
          hiddenIds.push(column.id);
        }
      }

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
      // Horizontal auto-scroll only when this table owns its scroll. In the
      // grouped layout the table shares the outer scroller, so this element is
      // not scrollable; Atlaskit then warns on every drag tick and Vite
      // serializes the whole element into the terminal, ballooning the dev log
      // to gigabytes and OOM-killing the dev server. Owning the scroll is what
      // `outerScrollRef` answers; a table that merely draws no end filler
      // still scrolls itself.
      ...(inlineFlow
        ? []
        : [
            autoScrollForElements({
              element,
              getAllowedAxis: () => "horizontal",
            }),
          ]),
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
  }, [handleColumnReorder, inlineFlow]);

  useExternalSyncEffect(() => {
    const element = tableWrapperRef.current;
    const headerRows = headerRowsRef.current;
    if (!element || !headerRows) {
      return undefined;
    }

    const updateMetrics = () => {
      const nextWrapperWidth = element.clientWidth;
      const nextVerticalScrollbarWidth = getVerticalScrollbarWidth(element);
      updateWrapperWidth(nextWrapperWidth);
      updateVerticalScrollbarWidth(nextVerticalScrollbarWidth);
      updateHeaderHeight(headerRows.getBoundingClientRect().height);
    };

    updateMetrics();
    const resizeObserver = new ResizeObserver(updateMetrics);
    resizeObserver.observe(element);
    resizeObserver.observe(headerRows);

    return () => resizeObserver.disconnect();
  }, [
    inlineFlow,
    updateHeaderHeight,
    updateVerticalScrollbarWidth,
    updateWrapperWidth,
  ]);

  useLayoutEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) {
      return;
    }

    const previous = previousScrollMetrics.current;
    const next: HorizontalScrollMetrics = { tableWidth, wrapperWidth };
    previousScrollMetrics.current = next;

    const anchored = anchoredHorizontalScroll({
      next,
      previous,
      scrollLeft: element.scrollLeft,
    });
    if (anchored !== null) {
      element.scrollLeft = anchored;
    }
  }, [tableWidth, wrapperWidth]);

  return (
    <div
      className={cn(
        "relative",
        !inlineFlow && "h-full flex-1",
        addPropertyColumn && ADD_PROPERTY_RAIL_ACTIVE_CLASS_NAME,
      )}
    >
      <div
        className={cn(
          inlineFlow ? "w-full" : "scrollbar-subtle h-full overflow-auto",
        )}
        data-slot="workspace-table-scroll"
        ref={tableWrapperRef}
      >
        <div
          aria-busy={showsSkeletonRows || undefined}
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
            ref={headerRowsRef}
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
                    headerTrigger={addColumnHeaderTrigger}
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
                <Fragment key={row.id}>
                  {rowHost.renderRow({
                    addPropertyColumn,
                    contentMode,
                    expandedCellId:
                      expandedTableCell?.rowId === row.id
                        ? expandedTableCell.columnId
                        : null,
                    hasExpandedTableCell: expandedTableCell !== null,
                    index,
                    lastSelectedIndex,
                    measureElement: rowVirtualizer.measureElement,
                    onToggleExpandedCell: handleToggleExpandedCell,
                    renderColumns,
                    row,
                    rowLabel: rowLabels[index] ?? "",
                    table,
                  })}
                </Fragment>
              );
            })}
            {showsSkeletonRows && (
              <WorkspaceTableSkeletonRows
                addPropertyColumn={addPropertyColumn}
                renderColumns={renderColumns}
                rowCount={skeletonRowCount}
              />
            )}
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
            {hasNextPage && (
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
            {rowHost.bottomRow}
          </div>
        </div>
      </div>
      {!inlineFlow &&
        addPropertyColumn !== null &&
        rowHost.addColumnRail !== undefined && (
          <div
            className="absolute top-0 bottom-12 z-40 w-12"
            style={addColumnRailStyle({
              headerHeightPx: headerHeight,
              scrollbarWidthPx: verticalScrollbarWidth,
            })}
          >
            {rowHost.addColumnRail}
          </div>
        )}
    </div>
  );
};
