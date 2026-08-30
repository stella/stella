import {
  type Key,
  type ReactNode,
  type RefObject,
  type UIEvent,
  useId,
  useRef,
} from "react";

import type { UniqueIdentifier } from "@dnd-kit/core";
import {
  SortableContext,
  type SortableContextProps,
  type SortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "../lib/utils";
import {
  useKanbanDropTarget,
  type UseKanbanDropTargetOptions,
} from "./sortable-interactions";

const DEFAULT_ESTIMATE_SIZE_PX = 128;
const DEFAULT_OVERSCAN = 8;
const DEFAULT_LOAD_MORE_THRESHOLD_PX = 200;

export const KANBAN_VIRTUAL_CELL_PAGINATION = {
  NONE: "none",
  CURSOR: "cursor",
} as const;

export type KanbanVirtualCellPagination =
  | { type: "none" }
  | {
      type: "cursor";
      hasMore: boolean;
      loading: boolean;
      pageKey: string | number;
      onRequestMore: () => void;
    };

/**
 * Makes a virtual cell the canonical sortable context for its rendered rows.
 *
 * `getRowKey` remains responsible for React and virtualizer identity. A
 * separate sortable identifier avoids narrowing an existing React key contract
 * merely to support dnd-kit consumers.
 */
export type KanbanVirtualCellSortableContext<TRow> = {
  dropTarget: Omit<UseKanbanDropTargetOptions, "itemIds">;
  getRowId: (row: TRow) => UniqueIdentifier;
  disabled?: SortableContextProps["disabled"] | undefined;
  strategy?: SortingStrategy | undefined;
};

export type KanbanVirtualCellProps<TRow> = {
  rows: readonly TRow[];
  getRowKey: (row: TRow) => Key;
  renderRow: (row: TRow) => ReactNode;
  pagination: KanbanVirtualCellPagination;
  sortable?: KanbanVirtualCellSortableContext<TRow> | undefined;
  containerRef?: RefObject<HTMLDivElement | null> | undefined;
  active?: boolean | undefined;
  backgroundColor?: string | undefined;
  footer?: ReactNode;
  estimateSize?: number | undefined;
  overscan?: number | undefined;
  loadMoreThreshold?: number | undefined;
  className?: string | undefined;
};

/** Bounded, virtualized Kanban cell with cursor-page request deduplication. */
export const KanbanVirtualCell = <TRow,>({
  rows,
  getRowKey,
  renderRow,
  pagination,
  sortable,
  containerRef,
  active = false,
  backgroundColor,
  footer,
  estimateSize = DEFAULT_ESTIMATE_SIZE_PX,
  overscan = DEFAULT_OVERSCAN,
  loadMoreThreshold = DEFAULT_LOAD_MORE_THRESHOLD_PX,
  className,
}: KanbanVirtualCellProps<TRow>) => {
  const internalRef = useRef<HTMLDivElement>(null);
  const fallbackDropTargetId = useId();
  const scrollRef = internalRef;
  const requestedPageKeyRef = useRef<string | number | null>(null);
  const itemIds = sortable ? rows.map(sortable.getRowId) : [];
  const dropTarget = useKanbanDropTarget({
    disabled: sortable?.dropTarget.disabled ?? sortable === undefined,
    id: sortable?.dropTarget.id ?? fallbackDropTargetId,
    itemIds,
    position: sortable?.dropTarget.position ?? { column: -1, lane: -1 },
  });
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => estimateSize,
    getItemKey: (index) => {
      const row = rows.at(index);
      return row === undefined ? index : getRowKey(row);
    },
    getScrollElement: () => scrollRef.current,
    overscan,
  });

  const handleScroll = ({ currentTarget }: UIEvent<HTMLDivElement>) => {
    if (
      pagination.type !== "cursor" ||
      !pagination.hasMore ||
      pagination.loading
    ) {
      return;
    }
    const remaining =
      currentTarget.scrollHeight -
      currentTarget.scrollTop -
      currentTarget.clientHeight;
    if (remaining > loadMoreThreshold) {
      return;
    }
    if (requestedPageKeyRef.current === pagination.pageKey) {
      return;
    }
    requestedPageKeyRef.current = pagination.pageKey;
    pagination.onRequestMore();
  };

  const setScrollElement = (element: HTMLDivElement | null) => {
    internalRef.current = element;
    if (containerRef) {
      containerRef.current = element;
    }
    dropTarget.setNodeRef(element);
  };

  const content = (
    <div
      className={cn(
        "bg-muted/20 max-h-[min(60vh,40rem)] min-h-20 overflow-y-auto overscroll-y-contain rounded-xl p-2 transition-[background-color,outline-color]",
        active && "bg-primary/5 ring-primary/50 ring-2",
        className,
      )}
      data-kanban-cell={sortable?.dropTarget.id}
      onScroll={handleScroll}
      ref={setScrollElement}
      style={backgroundColor ? { backgroundColor } : undefined}
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows.at(virtualRow.index);
          if (row === undefined) {
            return null;
          }
          return (
            <div
              className="absolute inset-x-0 top-0 pb-2"
              data-index={virtualRow.index}
              key={getRowKey(row)}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );

  if (sortable === undefined) {
    return content;
  }

  return (
    <SortableContext
      {...(sortable.disabled === undefined
        ? {}
        : { disabled: sortable.disabled })}
      id={sortable.dropTarget.id}
      items={itemIds}
      strategy={sortable.strategy ?? verticalListSortingStrategy}
    >
      {content}
    </SortableContext>
  );
};
