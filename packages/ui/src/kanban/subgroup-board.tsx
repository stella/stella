import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactElement, ReactNode } from "react";

import { ChevronDownIcon } from "lucide-react";

import { DirectionalIcon } from "../components/directional-icon";
import { cn } from "../lib/utils";
import { createBandPeekController } from "./band-peek";
import type { BandPeekController } from "./band-peek";
import { KanbanColumnBandHeader } from "./column-band-header";
import type { KanbanBandToggleActivation } from "./column-band-header";
import {
  KANBAN_COLLAPSED_BAND_WIDTH_CLASS,
  KANBAN_COLUMN_GAP_PX,
  KANBAN_COLUMN_WIDTH_CLASS,
  KANBAN_COLUMN_WIDTH_PX,
  resolveKanbanColumnBands,
} from "./column-bands";
import type { KanbanColumnBandSpan } from "./column-bands";
import { KANBAN_CARD_DRAG_MIME } from "./drag-interactions";
import type { KanbanColumnBand, KanbanGroup } from "./grouping";
import {
  KANBAN_CHROME_ROW_HEIGHT,
  KANBAN_CHROME_ROW_HEIGHT_PX,
} from "./layout-tokens";
import type {
  KanbanBoardCell,
  KanbanBoardColumn,
  KanbanBoardMatrix,
} from "./matrix";
import {
  KANBAN_STICKY_TOP_CLASS,
  KANBAN_STICKY_TOP_VAR,
  KanbanCollapsedBandCaption,
} from "./sticky-lane";
import type { KanbanStickyTopStyle } from "./sticky-lane";

/**
 * How far a lane's own pinned row reaches: its identity line over the line of
 * per-column summaries, each fixed at the chrome row height.
 *
 * Stated rather than measured, because both lines are fixed by construction —
 * a caller's summary or action renders inside a row that cannot grow — and the
 * cells below have to know the offset before the first paint, or every card's
 * pinned identity row spends that frame parked where the lane row is about
 * to be.
 */
const LANE_ROW_HEIGHT_PX = KANBAN_CHROME_ROW_HEIGHT_PX * 2;

/**
 * A finger's 44px target on a toggle the chrome row keeps at 36px.
 *
 * The same pseudo-element the shared `Button` extends its own targets with:
 * the visible control keeps the row's height, and only the touch surface
 * grows. It grows evenly above and below rather than downwards, so the extra
 * reach stops well short of the controls a caller renders in the summaries
 * under it — those sit at the far end of their own column, not under the
 * lane's name.
 */
const LANE_TOGGLE_COARSE_TARGET_CLASS =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1 pointer-coarse:after:min-h-11";

const groupValueKey = (value: string | null): string =>
  value === null ? "null" : `value:${value.length}:${value}`;
const columnKey = (column: KanbanBoardColumn): string =>
  column.type === "group"
    ? `group:${groupValueKey(column.group.value)}`
    : `destination:${column.destination.id}`;
const spanKey = (span: KanbanColumnBandSpan): string =>
  span.band === null
    ? `single:${span.columns.map(columnKey).join("|")}`
    : `band:${span.band.id}`;
const rowsIn = <TRow,>(cells: readonly KanbanBoardCell<TRow>[]): number =>
  cells.reduce((sum, cell) => sum + cell.rows.length, 0);

type Rendered = ReactElement | null;

export type KanbanSubgroupColumnHeaderContext = {
  column: KanbanBoardColumn;
  count: number;
};

export type KanbanSubgroupLaneIdentityContext = {
  group: KanbanGroup;
  count: number;
};

/** One column's cell in a lane's own row, and what that cell stands for. */
export type KanbanSubgroupLaneColumnSummaryContext = {
  lane: KanbanGroup;
  column: KanbanBoardColumn;
  /** Rows in this lane/column intersection, including zero. */
  count: number;
};

export type KanbanSubgroupLaneColumnActionContext = {
  lane: KanbanGroup;
  column: KanbanBoardColumn;
};

export type KanbanSubgroupCellContext<TRow> = {
  cell: KanbanBoardCell<TRow>;
  /** Number of rows in this lane/column intersection, including zero. */
  count: number;
  laneValue: string | null;
  /**
   * The band this cell's column belongs to, or `null` outside any band. Lets
   * a host that drives its own drag-and-drop (see `dragOverBandId` on the
   * board) map a cell's droppable id back to the band it should report.
   */
  band: KanbanColumnBand | null;
};

export type KanbanSubgroupBandHeaderContext = {
  band: KanbanColumnBand;
  columns: KanbanBoardColumn[];
  /** Rows across the band's columns, every lane included. */
  count: number;
  /** The persisted state the toggle reports and flips. */
  collapsed: boolean;
  /**
   * Whether the band renders as one narrow slot right now. False while a
   * collapsed band peeks open under the pointer, so a caption can show its
   * name and offer to pin the band open.
   */
  folded: boolean;
  /**
   * A custom caption may report which way it was activated (pointer vs.
   * keyboard); the board itself has no use for the distinction and passes
   * it through unread, purely as information for a host's own header.
   */
  onCollapsedChange: (
    collapsed: boolean,
    activation?: KanbanBandToggleActivation,
  ) => void;
};

/**
 * One lane's slot for a collapsed band: the cells it hides, so a host can
 * register the slot as a drop target that lands in the band's first column
 * (or asks which), and the count it stands in for.
 */
export type KanbanSubgroupCollapsedBandCellContext<TRow> = {
  band: KanbanColumnBand;
  cells: KanbanBoardCell<TRow>[];
  count: number;
  laneValue: string | null;
};

type KanbanSubgroupCollapseControl =
  | {
      isLaneCollapsed?: undefined;
      onLaneCollapsedChange?: undefined;
    }
  | {
      isLaneCollapsed: (group: KanbanGroup, count: number) => boolean;
      onLaneCollapsedChange: (group: KanbanGroup, collapsed: boolean) => void;
    };

export type KanbanSubgroupBoardProps<TRow> = {
  matrix: KanbanBoardMatrix<TRow>;
  renderColumnHeader: (context: KanbanSubgroupColumnHeaderContext) => ReactNode;
  renderLaneIdentity: (context: KanbanSubgroupLaneIdentityContext) => ReactNode;
  renderCell: (context: KanbanSubgroupCellContext<TRow>) => ReactNode;
  /**
   * What a lane's own row says about one column: its count by default. The
   * row is pinned, so this is the one line about a column that survives a
   * scroll down a lane hundreds of cards tall — a calculation belongs here
   * rather than at the end of a cell nobody reaches.
   */
  renderLaneColumnSummary?:
    | ((context: KanbanSubgroupLaneColumnSummaryContext) => ReactNode)
    | undefined;
  /**
   * The control at the end of a lane's cell for one column, such as adding a
   * card straight into that intersection. None by default.
   */
  renderLaneColumnAction?:
    | ((context: KanbanSubgroupLaneColumnActionContext) => ReactNode)
    | undefined;
  /**
   * The line above a band's columns. Defaults to `KanbanColumnBandHeader`
   * with the band's label and count.
   */
  renderBandHeader?:
    | ((context: KanbanSubgroupBandHeaderContext) => ReactNode)
    | undefined;
  /**
   * A lane's slot while its band is collapsed. Defaults to the band's name
   * set vertically over the count; a host that accepts drops into a collapsed
   * band renders its target here. Fill the slot's height (`h-full`) and
   * compose `KanbanCollapsedBandCaption` inside, so the name still stays
   * under the header halfway down a tall lane.
   */
  renderCollapsedBandCell?:
    | ((context: KanbanSubgroupCollapsedBandCellContext<TRow>) => ReactNode)
    | undefined;
  /** Accessible name for a band's collapse toggle. */
  formatBandToggleLabel?:
    | ((band: KanbanColumnBand, collapsed: boolean) => string)
    | undefined;
  /**
   * Controlled band collapse. Omit both and the board keeps the collapsed
   * bands itself; a persisted view supplies both.
   */
  isBandCollapsed?: ((band: KanbanColumnBand) => boolean) | undefined;
  onBandCollapsedChange?:
    | ((band: KanbanColumnBand, collapsed: boolean) => void)
    | undefined;
  formatCount?: ((count: number) => ReactNode) | undefined;
  footer?: ReactNode;
  className?: string | undefined;
  /**
   * The band whose folded slot (or, for a peeked band, whose open part) the
   * host's own drag is currently over, or `null` when it is over neither.
   * Omit (`undefined`) when the host does not drive drags itself — the
   * board's native `dragover`/`dragenter`/`dragleave` listeners already feed
   * the peek controller in that case. A host drives its own drag when it
   * builds the drop targets itself (for example a `KanbanSortableBoard`,
   * whose `onDragOver` reports the active `over` droppable); it maps that
   * droppable back to a band id — a folded cell's context and an open
   * cell's context (see `KanbanSubgroupCellContext.band`) both carry the
   * band — and passes it here. The controller treats "over the band" as
   * entering the open band when it is already peeked, and as hovering its
   * folded slot otherwise; leaving it is reported the same way.
   */
  dragOverBandId?: string | null | undefined;
  /**
   * Whether the host's own drag (see `dragOverBandId`) is in progress.
   * Flipping to `false` ends any peek immediately, mirroring the native
   * `dragend`/`drop` listeners the board installs for its own drags.
   */
  isDragging?: boolean | undefined;
} & KanbanSubgroupCollapseControl;

/**
 * Reusable swimlane layout over the canonical two-axis Kanban matrix.
 *
 * Every lane leads with a row of its own, pinned on both axes: its name at the
 * visible inline edge, and beside each column what that column holds in this
 * lane, so a reader deep inside a lane still knows which lane it is and what
 * is around them.
 *
 * Columns that carry band metadata render under a one-line band caption and
 * can be collapsed as a run: the band folds into one narrow slot in every
 * row, whose cells stay reachable (a host renders its drop target in them),
 * and peeks open while a dragged card rests on it, so a drag can still land
 * on a specific column inside; a plain hover never opens it. Every row is laid out span by span with the same
 * widths, which is what keeps captions, headers, counts, and cells aligned
 * in every state; the caption line never grows past its own height, so a
 * folded band costs no vertical space.
 */
export const KanbanSubgroupBoard = <TRow,>({
  matrix,
  renderColumnHeader,
  renderLaneIdentity,
  renderCell,
  renderLaneColumnSummary,
  renderLaneColumnAction,
  renderBandHeader,
  renderCollapsedBandCell,
  formatBandToggleLabel,
  formatCount = String,
  isLaneCollapsed,
  onLaneCollapsedChange,
  isBandCollapsed,
  onBandCollapsedChange,
  footer,
  className,
  dragOverBandId,
  isDragging,
}: KanbanSubgroupBoardProps<TRow>) => {
  const [collapsedLaneValues, setCollapsedLaneValues] = useState(
    () => new Set<string | null>(),
  );
  const [expandedEmptyLaneValues, setExpandedEmptyLaneValues] = useState(
    () => new Set<string | null>(),
  );
  const [collapsedBandIds, setCollapsedBandIds] = useState(
    () => new Set<string>(),
  );
  const [peekingBandId, setPeekingBandId] = useState<string | null>(null);
  // How far the sticky header block reaches into this scroll container. Lane
  // controls stick under it (see `sticky-lane.tsx`); zero until measured, so
  // server-rendered markup carries a usable offset.
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const header = headerRef.current;
    if (header === null) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setHeaderHeight(header.getBoundingClientRect().height);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  // The peek's timing rules live in one controller (see `band-peek.ts`); the
  // board only mirrors which band it reports open.
  const [peek] = useState(() =>
    createBandPeekController({ onChange: setPeekingBandId }),
  );
  useEffect(() => () => peek.dispose(), [peek]);
  // A drop or a cancelled drag ends the peek wherever the card was; the
  // open band may never see a leave for it.
  useEffect(() => {
    const end = () => peek.dragEnded();
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, [peek]);
  // A host that drives its own drag (dnd-kit, rather than the board's native
  // listeners) reports the band its drag is over directly. `undefined` means
  // the host does not drive drags at all, so no comparison against the
  // previous id ever runs.
  const previousDragOverBandId = useRef<string | null>(null);
  useEffect(() => {
    if (
      dragOverBandId === undefined ||
      dragOverBandId === previousDragOverBandId.current
    ) {
      return;
    }
    const previous = previousDragOverBandId.current;
    previousDragOverBandId.current = dragOverBandId;
    if (previous !== null) {
      if (peekingBandId === previous) {
        peek.openDragLeave(previous);
      } else {
        peek.slotDragLeave(previous);
      }
    }
    if (dragOverBandId !== null) {
      if (peekingBandId === dragOverBandId) {
        peek.openDragEnter(dragOverBandId);
      } else {
        peek.slotDragOver(dragOverBandId);
      }
    }
  }, [dragOverBandId, peek, peekingBandId]);
  useEffect(() => {
    if (isDragging === false) {
      previousDragOverBandId.current = null;
      peek.dragEnded();
    }
  }, [isDragging, peek]);

  const { cellsByLaneValue, countByColumnValue, ungroupedCells } =
    useMemo(() => {
      const laneCells = new Map<string | null, KanbanBoardCell<TRow>[]>();
      const columnCounts = new Map<string, number>();
      const cellsWithoutLane: KanbanBoardCell<TRow>[] = [];
      for (const cell of matrix.cells) {
        const key = columnKey(cell.coordinate.column);
        columnCounts.set(key, (columnCounts.get(key) ?? 0) + cell.rows.length);
        if (cell.coordinate.lane.type === "none") {
          cellsWithoutLane.push(cell);
          continue;
        }
        const laneValue = cell.coordinate.lane.group.value;
        const currentLaneCells = laneCells.get(laneValue);
        if (currentLaneCells) {
          currentLaneCells.push(cell);
        } else {
          laneCells.set(laneValue, [cell]);
        }
      }
      return {
        cellsByLaneValue: laneCells,
        countByColumnValue: columnCounts,
        ungroupedCells: cellsWithoutLane,
      };
    }, [matrix.cells]);
  const spans = useMemo(
    () => resolveKanbanColumnBands(matrix.columns),
    [matrix.columns],
  );
  const hasBands = spans.some((span) => span.band !== null);

  const setLaneCollapsed = (
    group: KanbanGroup,
    count: number,
    collapsed: boolean,
  ) => {
    if (onLaneCollapsedChange) {
      onLaneCollapsedChange(group, collapsed);
      return;
    }
    const value = group.value;
    if (count === 0) {
      setExpandedEmptyLaneValues((current) => {
        const next = new Set(current);
        if (collapsed) {
          next.delete(value);
        } else {
          next.add(value);
        }
        return next;
      });
      return;
    }
    setCollapsedLaneValues((current) => {
      const next = new Set(current);
      if (collapsed) {
        next.add(value);
      } else {
        next.delete(value);
      }
      return next;
    });
  };

  /** The band's persisted state: what the toggle reports and flips. */
  const isBandCollapsedNow = (band: KanbanColumnBand): boolean =>
    isBandCollapsed ? isBandCollapsed(band) : collapsedBandIds.has(band.id);
  /**
   * Whether the band renders folded right now. A peek opens the layout
   * without changing the persisted state, so a peeked band still reports
   * itself collapsed and its toggle pins it open rather than closing it.
   */
  const isBandFolded = (band: KanbanColumnBand): boolean =>
    peekingBandId !== band.id && isBandCollapsedNow(band);
  // A peek belongs to a band that is collapsed by state. When a controlled
  // caller expands that band, or a matrix change removes it, no open element
  // of it may ever emit a leave, so the controller is told directly.
  const peekedBand =
    peekingBandId === null
      ? null
      : (spans.find((span) => span.band?.id === peekingBandId)?.band ?? null);
  const staleBandId =
    peekingBandId !== null &&
    (peekedBand === null || !isBandCollapsedNow(peekedBand))
      ? peekingBandId
      : null;
  useEffect(() => {
    if (staleBandId !== null) {
      peek.bandExpanded(staleBandId);
    }
  }, [peek, staleBandId]);
  // `activation` (pointer vs. keyboard) only ever mattered to a suppression
  // rule the drag-only peek lifecycle can no longer support, so the board
  // itself ignores it now; it stays informational, for a host's own header.
  const setBandCollapsed = (band: KanbanColumnBand, collapsed: boolean) => {
    if (collapsed) {
      peek.bandFolded(band.id);
    } else {
      peek.bandExpanded(band.id);
    }
    if (onBandCollapsedChange) {
      onBandCollapsedChange(band, collapsed);
      return;
    }
    setCollapsedBandIds((current) => {
      const next = new Set(current);
      if (collapsed) {
        next.add(band.id);
      } else {
        next.delete(band.id);
      }
      return next;
    });
  };

  const columnCount = (column: KanbanBoardColumn) =>
    countByColumnValue.get(columnKey(column)) ?? 0;
  const cellsOf = (
    span: KanbanColumnBandSpan,
    cells: readonly KanbanBoardCell<TRow>[],
  ) =>
    span.columns.flatMap((column) =>
      cells.filter(
        (cell) => columnKey(cell.coordinate.column) === columnKey(column),
      ),
    );
  const spanWidth = (span: KanbanColumnBandSpan) =>
    span.columns.length * KANBAN_COLUMN_WIDTH_PX +
    (span.columns.length - 1) * KANBAN_COLUMN_GAP_PX;

  /**
   * One row of the board, span by span. A folded band takes one narrow slot
   * in every row; an open span lays its columns out at the column width.
   */
  const renderRow = ({
    className: rowClassName,
    label,
    renderColumn,
    renderFoldedBand,
  }: {
    className?: string;
    label?: string;
    renderColumn: (
      column: KanbanBoardColumn,
      band: KanbanColumnBand | null,
    ) => Rendered;
    renderFoldedBand: (
      band: KanbanColumnBand,
      span: KanbanColumnBandSpan,
    ) => Rendered;
  }) => (
    <div aria-label={label} className={cn("flex gap-3", rowClassName)}>
      {spans.map((span) => {
        const band = span.band;
        if (band !== null && isBandFolded(band)) {
          return (
            <FoldedBandSlot
              band={band}
              className={KANBAN_COLLAPSED_BAND_WIDTH_CLASS}
              key={spanKey(span)}
              peek={peek}
            >
              {renderFoldedBand(band, span)}
            </FoldedBandSlot>
          );
        }
        return (
          <div
            className="flex gap-3"
            data-kanban-band={band?.id}
            key={spanKey(span)}
            onDragEnter={
              band === null
                ? undefined
                : (event) => {
                    if (isKanbanCardDragEvent(event)) {
                      peek.openDragEnter(band.id);
                    }
                  }
            }
            onDragLeave={
              band === null
                ? undefined
                : (event) => {
                    if (leavesElement(event) && isKanbanCardDragEvent(event)) {
                      peek.openDragLeave(band.id);
                    }
                  }
            }
          >
            {span.columns.map((column) => (
              <div
                className={KANBAN_COLUMN_WIDTH_CLASS}
                key={columnKey(column)}
              >
                {renderColumn(column, band)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );

  const bandHeader = (
    band: KanbanColumnBand,
    span: KanbanColumnBandSpan,
  ): Rendered => {
    const collapsed = isBandCollapsedNow(band);
    const folded = isBandFolded(band);
    const context: KanbanSubgroupBandHeaderContext = {
      band,
      collapsed,
      columns: span.columns,
      count: span.columns.reduce((sum, column) => sum + columnCount(column), 0),
      folded,
      onCollapsedChange: (next) => setBandCollapsed(band, next),
    };
    if (renderBandHeader) {
      return <>{renderBandHeader(context)}</>;
    }
    return (
      <KanbanColumnBandHeader
        collapsed={collapsed}
        compact={folded}
        meta={formatCount(context.count)}
        title={band.label}
        toggleLabel={
          formatBandToggleLabel
            ? formatBandToggleLabel(band, collapsed)
            : band.label
        }
        onCollapsedChange={context.onCollapsedChange}
      />
    );
  };

  const foldedCell = (
    band: KanbanColumnBand,
    span: KanbanColumnBandSpan,
    cells: readonly KanbanBoardCell<TRow>[],
    laneValue: string | null,
  ): Rendered => {
    const bandCells = cellsOf(span, cells);
    const count = rowsIn(bandCells);
    if (renderCollapsedBandCell) {
      return (
        <>
          {renderCollapsedBandCell({
            band,
            cells: bandCells,
            count,
            laneValue,
          })}
        </>
      );
    }
    return (
      // The caption travels through the slot's full height, so it stays
      // under the header until the lane ends rather than scrolling away
      // with the first cards.
      <div
        className="flex h-full flex-col items-center"
        data-kanban-collapsed-band-count={count}
      >
        <KanbanCollapsedBandCaption
          label={band.label}
          meta={formatCount(count)}
        />
      </div>
    );
  };

  const foldedCount = (
    span: KanbanColumnBandSpan,
    cells: readonly KanbanBoardCell<TRow>[],
  ): Rendered => {
    const count = rowsIn(cellsOf(span, cells));
    return (
      <div
        className={cn(
          "flex items-center justify-center",
          KANBAN_CHROME_ROW_HEIGHT,
        )}
        data-kanban-lane-column-count={count}
      >
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatCount(count)}
        </span>
      </div>
    );
  };

  /** One column's cell in a lane's row: what it holds, then what it offers. */
  const laneColumnCell = (
    group: KanbanGroup,
    column: KanbanBoardColumn,
    count: number,
  ): Rendered => (
    <div
      className={cn("flex items-center gap-1 px-3", KANBAN_CHROME_ROW_HEIGHT)}
      data-kanban-lane-column-count={count}
    >
      {renderLaneColumnSummary ? (
        renderLaneColumnSummary({ column, count, lane: group })
      ) : (
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatCount(count)}
        </span>
      )}
      {renderLaneColumnAction === undefined ? null : (
        <span className="ms-auto flex items-center">
          {renderLaneColumnAction({ column, lane: group })}
        </span>
      )}
    </div>
  );

  const stickyTopStyle: KanbanStickyTopStyle = {
    [KANBAN_STICKY_TOP_VAR]: `${String(headerHeight)}px`,
  };
  /**
   * What a lane's cells find pinned above them: the board's header and the
   * lane's own row. Restating the offset rather than adding to the inherited
   * one, because a custom property that reads itself is a cycle and resolves
   * to nothing at all.
   */
  const laneCellsStickyTopStyle: KanbanStickyTopStyle = {
    [KANBAN_STICKY_TOP_VAR]: `${String(headerHeight + LANE_ROW_HEIGHT_PX)}px`,
  };

  return (
    <div
      className={cn("h-full overflow-auto px-4 pb-4", className)}
      style={stickyTopStyle}
    >
      <div className="min-w-max">
        <div
          className="bg-background sticky top-0 z-20"
          data-kanban-board-header=""
          ref={headerRef}
        >
          {hasBands ? (
            <div className="flex items-end gap-3 pb-1" data-kanban-band-row="">
              {spans.map((span) => {
                const band = span.band;
                if (band === null) {
                  return (
                    <div
                      className="shrink-0"
                      key={spanKey(span)}
                      style={{ width: `${String(spanWidth(span))}px` }}
                    />
                  );
                }
                if (isBandFolded(band)) {
                  return (
                    <FoldedBandSlot
                      band={band}
                      className={cn(
                        "border-border/60 border-b",
                        KANBAN_COLLAPSED_BAND_WIDTH_CLASS,
                      )}
                      key={spanKey(span)}
                      peek={peek}
                    >
                      {bandHeader(band, span)}
                    </FoldedBandSlot>
                  );
                }
                return (
                  <div
                    className="border-border/60 shrink-0 border-b"
                    data-kanban-band={band.id}
                    key={spanKey(span)}
                    style={{ width: `${String(spanWidth(span))}px` }}
                    onDragEnter={(event) => {
                      if (isKanbanCardDragEvent(event)) {
                        peek.openDragEnter(band.id);
                      }
                    }}
                    onDragLeave={(event) => {
                      if (
                        leavesElement(event) &&
                        isKanbanCardDragEvent(event)
                      ) {
                        peek.openDragLeave(band.id);
                      }
                    }}
                  >
                    {/* The caption travels the width of its own band: a board
                     * scrolled sideways keeps it at the visible edge until
                     * the band it names is gone, rather than letting the name
                     * leave while the columns under it are still on screen.
                     * It has to size to its content to have any room to
                     * travel, and stops at the band's own width, which is as
                     * far as a caption for that band means anything. */}
                    <div
                      className="bg-background sticky start-0 z-10 w-fit max-w-full"
                      data-kanban-band-caption=""
                    >
                      {bandHeader(band, span)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {renderRow({
            renderColumn: (column) => (
              <>{renderColumnHeader({ column, count: columnCount(column) })}</>
            ),
            renderFoldedBand: () => null,
          })}
        </div>

        {ungroupedCells.length === 0
          ? null
          : renderRow({
              className: "pb-1",
              renderColumn: (column, band) => {
                const cell = ungroupedCells.find(
                  (candidate) =>
                    columnKey(candidate.coordinate.column) ===
                    columnKey(column),
                );
                return cell === undefined ? null : (
                  <>
                    {renderCell({
                      band,
                      cell,
                      count: cell.rows.length,
                      laneValue: null,
                    })}
                  </>
                );
              },
              renderFoldedBand: (band, span) =>
                foldedCell(band, span, ungroupedCells, null),
            })}

        {matrix.lanes.map((lane) => {
          if (lane.type === "none") {
            return null;
          }
          const { group } = lane;
          const cells = cellsByLaneValue.get(group.value) ?? [];
          const count = rowsIn(cells);
          const defaultCollapsed =
            count === 0
              ? !expandedEmptyLaneValues.has(group.value)
              : collapsedLaneValues.has(group.value);
          const collapsed = isLaneCollapsed
            ? isLaneCollapsed(group, count)
            : defaultCollapsed;
          const cellFor = (column: KanbanBoardColumn) =>
            cells.find(
              (candidate) =>
                columnKey(candidate.coordinate.column) === columnKey(column),
            );

          return (
            <section
              className="border-border/60 border-b py-1 first:pt-0 last:border-b-0"
              key={groupValueKey(group.value)}
            >
              {/* The lane's own row, pinned on both axes: its name holds the
               * visible inline edge of a board scrolled sideways, and the
               * whole row comes to rest under the board's header so a reader
               * halfway down a lane still has its name and what each of its
               * columns holds. The summaries stand beside the cells rather
               * than in place of them, which is why a lane shows them open as
               * well as collapsed. */}
              <div
                className={cn(
                  "bg-background sticky z-10",
                  KANBAN_STICKY_TOP_CLASS,
                )}
                data-kanban-lane-row=""
              >
                <div
                  className={cn(
                    "sticky start-0 flex w-fit items-center",
                    KANBAN_CHROME_ROW_HEIGHT,
                  )}
                >
                  <button
                    aria-expanded={!collapsed}
                    className={cn(
                      "hover:bg-muted/60 flex items-center gap-2 rounded-lg px-2 text-start transition-[background-color]",
                      KANBAN_CHROME_ROW_HEIGHT,
                      LANE_TOGGLE_COARSE_TARGET_CLASS,
                    )}
                    onClick={() => setLaneCollapsed(group, count, !collapsed)}
                    type="button"
                  >
                    <DirectionalIcon
                      className={cn(
                        "text-muted-foreground size-4 shrink-0 transition-transform",
                        collapsed && "-rotate-90",
                      )}
                      flip={collapsed}
                      icon={ChevronDownIcon}
                    />
                    {renderLaneIdentity({ group, count })}
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatCount(count)}
                    </span>
                  </button>
                </div>

                {renderRow({
                  label: "Lane column summaries",
                  renderColumn: (column) =>
                    laneColumnCell(
                      group,
                      column,
                      cellFor(column)?.rows.length ?? 0,
                    ),
                  // A folded band stands for several columns at once, so its
                  // slot can only carry the total; there is no room for the
                  // per-column pair the open columns show.
                  renderFoldedBand: (_band, span) => foldedCount(span, cells),
                })}
              </div>

              {/* The cells find the lane's row pinned above them as well as
               * the board's header, so they are told the total reach rather
               * than the header's alone. */}
              {!collapsed && (
                <div style={laneCellsStickyTopStyle}>
                  {renderRow({
                    className: "pb-1",
                    renderColumn: (column, band) => {
                      const cell = cellFor(column);
                      return cell === undefined ? null : (
                        <>
                          {renderCell({
                            band,
                            cell,
                            count: cell.rows.length,
                            laneValue: group.value,
                          })}
                        </>
                      );
                    },
                    renderFoldedBand: (band, span) =>
                      foldedCell(band, span, cells, group.value),
                  })}
                </div>
              )}
            </section>
          );
        })}

        {footer}
      </div>
    </div>
  );
};

/**
 * Whether a drag-leave event actually leaves `currentTarget` rather than
 * moving between its descendants, which fire leave/enter pairs of their own.
 */
const leavesElement = (event: DragEvent<HTMLElement>): boolean =>
  !(
    event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)
  );

/**
 * Whether a native drag event is a kanban card drag, rather than some other
 * native drag (a column reorder, a file, text) passing over the board. Only
 * a card drag should ever open or hold a band's peek.
 */
const isKanbanCardDragEvent = (event: DragEvent<HTMLElement>): boolean =>
  event.dataTransfer.types.includes(KANBAN_CARD_DRAG_MIME);

type FoldedBandSlotProps = {
  band: KanbanColumnBand;
  children: ReactNode;
  className: string;
  peek: BandPeekController;
};

/**
 * The narrow slot a folded band occupies in a row. Its drag events go to
 * the board's peek controller, which decides when a resting drag peeks the
 * band open.
 */
const FoldedBandSlot = ({
  band,
  children,
  className,
  peek,
}: FoldedBandSlotProps) => {
  // A slot that leaves the DOM mid-delay (its band expanded or disappeared)
  // takes its pending peek with it.
  useEffect(() => () => peek.slotUnmounted(band.id), [peek, band.id]);
  return (
    <div
      className={className}
      data-kanban-band={band.id}
      data-kanban-band-collapsed=""
      onDragOver={(event) => {
        if (isKanbanCardDragEvent(event)) {
          peek.slotDragOver(band.id);
        }
      }}
      onDragLeave={(event) => {
        if (leavesElement(event) && isKanbanCardDragEvent(event)) {
          peek.slotDragLeave(band.id);
        }
      }}
    >
      {children}
    </div>
  );
};
