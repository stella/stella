import {
  type CSSProperties,
  type Key,
  type ReactNode,
  type RefObject,
  type UIEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useDndContext, type UniqueIdentifier } from "@dnd-kit/core";
import {
  SortableContext,
  type SortableContextProps,
  type SortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";

import { type OptionColor, resolveOptionColor } from "../lib/option-color";
import { cn } from "../lib/utils";
import {
  useKanbanDropTarget,
  type KanbanVirtualScrollRequest,
  type UseKanbanDropTargetOptions,
} from "./sortable-interactions";
import {
  KANBAN_CARD_STICKY_TOP_VAR,
  KANBAN_STICKY_TOP_CLASS,
  resolveKanbanCardStickyTop,
  type KanbanCardStickyTopStyle,
} from "./sticky-lane";

const DEFAULT_ESTIMATE_SIZE_PX = 128;
const DEFAULT_OVERSCAN = 8;
const DEFAULT_LOAD_MORE_THRESHOLD_PX = 200;

/** The CSS custom property every accent tint and the active accent ring are
 *  derived from, so both stay in lockstep with the resolved colour token. */
const KANBAN_CELL_ACCENT_VAR = "--kanban-cell-accent" as const;

/** Faint resting wash: matches the alpha `option-color` already uses for its
 *  own subtle background token, so a tinted cell reads at the same weight as
 *  the swatch and badges that carry the same colour. */
const KANBAN_CELL_ACCENT_RESTING_ALPHA = 12;
/** Stronger wash while a card is dragged over an accented cell. */
const KANBAN_CELL_ACCENT_ACTIVE_ALPHA = 22;
/** Ring alpha for the active accent frame, well above the wash so the frame
 *  still reads as the drag-over affordance rather than more background tint. */
const KANBAN_CELL_ACCENT_ACTIVE_RING_ALPHA = 55;

/** The neutral resting surface, in one place: a pinned action repaints it
 *  over an opaque base, and the two must read as one surface. */
const KANBAN_CELL_SURFACE_CLASS = "bg-muted/20";
/** A caller's own surface (an explicit colour, or the accent wash), published
 *  so a pinned action can repaint that one instead. */
const KANBAN_CELL_SURFACE_VAR = "--kanban-cell-surface" as const;

type KanbanCellStyle = CSSProperties & {
  [KANBAN_CELL_ACCENT_VAR]?: string;
  [KANBAN_CELL_SURFACE_VAR]?: string;
};

const retainActiveSortableIndex = (
  range: Range,
  activeIndex: number,
): number[] => {
  const indexes = defaultRangeExtractor(range);
  if (activeIndex < 0 || indexes.includes(activeIndex)) {
    return indexes;
  }
  indexes.push(activeIndex);
  indexes.sort((left, right) => left - right);
  return indexes;
};

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
  dropTarget: Omit<UseKanbanDropTargetOptions, "itemIds" | "navigation">;
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
  /**
   * Optional colour identity for the cell surface: a faint resting tint at
   * the same alpha as `option-color`'s own subtle background, with a
   * stronger accent-coloured wash and ring while `active` is also set. Omit
   * for the plain neutral surface; `backgroundColor` still wins outright
   * when both are given, since that prop is the caller's explicit override.
   */
  accent?: OptionColor | undefined;
  footer?: ReactNode;
  /**
   * Where the `footer` sits. `"end"` closes the cell after its rows.
   * `"sticky-start"` puts it first and pins it to the top of the scroll
   * container the cell lives in, so the action stays reachable through a
   * lane hundreds of cards tall and releases where the lane ends.
   *
   * The offset comes from `KANBAN_STICKY_TOP_VAR`, which the board publishes
   * for its own sticky header. A cell that keeps its bounded surface is its
   * own scroll container, and the board's header means nothing inside it:
   * reset the variable to `0px` on such a cell (`[--kanban-sticky-top:0px]`)
   * so the action rests at the cell's own top.
   *
   * Either way the cell publishes the total reach of what is pinned above a
   * card as `KANBAN_CARD_STICKY_TOP_VAR` on every row it renders, so a card's
   * own sticky header comes to rest under the action rather than behind it.
   */
  footerPlacement?: "end" | "sticky-start" | undefined;
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
  accent,
  footer,
  footerPlacement = "end",
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
  const { active: activeDrag } = useDndContext();
  const activeSortableIndex =
    activeDrag === null ? -1 : itemIds.indexOf(activeDrag.id);
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => estimateSize,
    getItemKey: (index) => {
      const row = rows.at(index);
      return row === undefined ? index : getRowKey(row);
    },
    getScrollElement: () => scrollRef.current,
    overscan,
    rangeExtractor: (range) =>
      retainActiveSortableIndex(range, activeSortableIndex),
  });
  const requestScroll = ({ itemId }: KanbanVirtualScrollRequest) => {
    const index = itemIds.indexOf(itemId);
    if (index !== -1) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    }
  };
  const dropTarget = useKanbanDropTarget({
    disabled: sortable?.dropTarget.disabled ?? sortable === undefined,
    id: sortable?.dropTarget.id ?? fallbackDropTargetId,
    itemIds,
    navigation:
      sortable === undefined
        ? { type: "static" }
        : { requestScroll, type: "virtual" },
    position: sortable?.dropTarget.position ?? { column: -1, lane: -1 },
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

  const accentVariants =
    accent === undefined ? undefined : resolveOptionColor(accent);
  const accentAlpha = active
    ? KANBAN_CELL_ACCENT_ACTIVE_ALPHA
    : KANBAN_CELL_ACCENT_RESTING_ALPHA;
  const accentBackground =
    accentVariants === undefined
      ? undefined
      : `color-mix(in srgb, var(${KANBAN_CELL_ACCENT_VAR}) ${accentAlpha}%, var(--background))`;
  const activeAccentRing =
    active && accentVariants !== undefined
      ? `0 0 0 2px color-mix(in srgb, var(${KANBAN_CELL_ACCENT_VAR}) ${KANBAN_CELL_ACCENT_ACTIVE_RING_ALPHA}%, transparent)`
      : undefined;
  const surface = backgroundColor ?? accentBackground;
  const style: KanbanCellStyle | undefined =
    surface === undefined
      ? undefined
      : {
          backgroundColor: surface,
          [KANBAN_CELL_SURFACE_VAR]: surface,
          ...(activeAccentRing === undefined
            ? undefined
            : { boxShadow: activeAccentRing }),
          ...(accentVariants === undefined
            ? undefined
            : { [KANBAN_CELL_ACCENT_VAR]: accentVariants.color }),
        };

  const hasStickyFooter =
    footerPlacement === "sticky-start" &&
    footer !== null &&
    footer !== undefined;

  // A card's own pinned header rests under this action, so the cell has to say
  // how tall the action turned out: the caller controls its content, and it
  // reflows with the cell's width. Zero until measured, and zero whenever the
  // footer closes the cell instead, which leaves the board's offset alone.
  const stickyFooterRef = useRef<HTMLDivElement>(null);
  const [stickyFooterHeight, setStickyFooterHeight] = useState(0);
  useEffect(() => {
    const element = stickyFooterRef.current;
    if (element === null) {
      setStickyFooterHeight(0);
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setStickyFooterHeight(element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasStickyFooter]);

  // The resting surface is translucent unless a caller sets one of their own,
  // so a pinned action repaints the cell's surface over an opaque base: cards
  // pass behind the action instead of reading through it. The row keeps the
  // cards' own bottom padding, so pinning it shifts nothing below.
  const stickyFooter = hasStickyFooter ? (
    <div
      className={cn("bg-background sticky z-10", KANBAN_STICKY_TOP_CLASS)}
      data-kanban-cell-footer="sticky-start"
      ref={stickyFooterRef}
    >
      <div
        className={cn(
          "pb-2",
          surface === undefined
            ? KANBAN_CELL_SURFACE_CLASS
            : "bg-(--kanban-cell-surface)",
        )}
      >
        {footer}
      </div>
    </div>
  ) : null;

  const content = (
    <div
      className={cn(
        KANBAN_CELL_SURFACE_CLASS,
        "max-h-[min(60vh,40rem)] min-h-20 overflow-y-auto overscroll-y-contain rounded-xl p-2 transition-[background-color,outline-color]",
        active &&
          accentVariants === undefined &&
          "bg-primary/5 ring-primary/50 ring-2",
        className,
      )}
      data-kanban-cell={sortable?.dropTarget.id}
      data-kanban-cell-accent={
        accentVariants === undefined ? undefined : "true"
      }
      onScroll={handleScroll}
      ref={setScrollElement}
      style={style}
    >
      {stickyFooter}
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows.at(virtualRow.index);
          if (row === undefined) {
            return null;
          }
          const rowStyle: KanbanCardStickyTopStyle = {
            transform: `translateY(${String(virtualRow.start)}px)`,
            [KANBAN_CARD_STICKY_TOP_VAR]: resolveKanbanCardStickyTop({
              pinnedAbove: stickyFooterHeight,
              rowOffset: virtualRow.start,
            }),
          };
          return (
            <div
              className="absolute inset-x-0 top-0 pb-2"
              data-index={virtualRow.index}
              key={getRowKey(row)}
              ref={virtualizer.measureElement}
              style={rowStyle}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
      {footerPlacement === "end" ? footer : null}
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
