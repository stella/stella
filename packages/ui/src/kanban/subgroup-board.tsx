import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { ChevronDownIcon } from "lucide-react";

import { DirectionalIcon } from "../components/directional-icon";
import { cn } from "../lib/utils";
import { createBandPeekController } from "./band-peek";
import type { BandPeekController } from "./band-peek";
import { KanbanColumnBandHeader } from "./column-band-header";
import {
  KANBAN_COLLAPSED_BAND_WIDTH_CLASS,
  KANBAN_COLUMN_GAP_PX,
  KANBAN_COLUMN_WIDTH_CLASS,
  KANBAN_COLUMN_WIDTH_PX,
  resolveKanbanColumnBands,
} from "./column-bands";
import type { KanbanColumnBandSpan } from "./column-bands";
import type { KanbanColumnBand, KanbanGroup } from "./grouping";
import type {
  KanbanBoardCell,
  KanbanBoardColumn,
  KanbanBoardMatrix,
} from "./matrix";

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

export type KanbanSubgroupCellContext<TRow> = {
  cell: KanbanBoardCell<TRow>;
  /** Number of rows in this lane/column intersection, including zero. */
  count: number;
  laneValue: string | null;
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
  onCollapsedChange: (collapsed: boolean) => void;
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
   * The line above a band's columns. Defaults to `KanbanColumnBandHeader`
   * with the band's label and count.
   */
  renderBandHeader?:
    | ((context: KanbanSubgroupBandHeaderContext) => ReactNode)
    | undefined;
  /**
   * A lane's slot while its band is collapsed. Defaults to the band's name
   * set vertically over the count; a host that accepts drops into a collapsed
   * band renders its target here.
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
} & KanbanSubgroupCollapseControl;

/**
 * Reusable swimlane layout over the canonical two-axis Kanban matrix.
 *
 * Columns that carry band metadata render under a one-line band caption and
 * can be collapsed as a run: the band folds into one narrow slot in every
 * row, whose cells stay reachable (a host renders its drop target in them),
 * and peeks open while a pointer rests on it, so a drag can still land on a
 * specific column inside. Every row is laid out span by span with the same
 * widths, which is what keeps captions, headers, counts, and cells aligned
 * in every state; the caption line never grows past its own height, so a
 * folded band costs no vertical space.
 */
export const KanbanSubgroupBoard = <TRow,>({
  matrix,
  renderColumnHeader,
  renderLaneIdentity,
  renderCell,
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
  // The peek's timing rules live in one controller (see `band-peek.ts`); the
  // board only mirrors which band it reports open.
  const [peek] = useState(() =>
    createBandPeekController({ onChange: setPeekingBandId }),
  );
  useEffect(() => () => peek.dispose(), [peek]);

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
  const setBandCollapsed = (band: KanbanColumnBand, collapsed: boolean) => {
    // A fold from the caption leaves the new slot under the pointer; the
    // controller keeps it from peeking straight back open.
    if (collapsed) {
      peek.foldedUnderPointer(band.id);
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
    renderColumn: (column: KanbanBoardColumn) => Rendered;
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
            onPointerEnter={
              band === null ? undefined : () => peek.openPointerEnter(band.id)
            }
            onPointerLeave={
              band === null ? undefined : () => peek.openPointerLeave(band.id)
            }
          >
            {span.columns.map((column) => (
              <div
                className={KANBAN_COLUMN_WIDTH_CLASS}
                key={columnKey(column)}
              >
                {renderColumn(column)}
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
      <div
        className="text-muted-foreground flex flex-col items-center gap-2 py-2 text-xs"
        data-kanban-collapsed-band-count={count}
      >
        <span className="max-h-40 truncate font-medium [writing-mode:vertical-rl]">
          {band.label}
        </span>
        <span className="tabular-nums">{formatCount(count)}</span>
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
        className="flex justify-center"
        data-kanban-lane-column-count={count}
      >
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatCount(count)}
        </span>
      </div>
    );
  };

  return (
    <div className={cn("h-full overflow-auto px-4 pb-4", className)}>
      <div className="min-w-max">
        <div className="bg-background sticky top-0 z-20 pt-4 pb-3">
          {hasBands ? (
            <div
              className="flex items-end gap-3 pb-1.5"
              data-kanban-band-row=""
            >
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
                    onPointerEnter={() => peek.openPointerEnter(band.id)}
                    onPointerLeave={() => peek.openPointerLeave(band.id)}
                  >
                    {bandHeader(band, span)}
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
              renderColumn: (column) => {
                const cell = ungroupedCells.find(
                  (candidate) =>
                    columnKey(candidate.coordinate.column) ===
                    columnKey(column),
                );
                return cell === undefined ? null : (
                  <>
                    {renderCell({
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
              className="border-border/60 border-b py-2 first:pt-0 last:border-b-0"
              key={groupValueKey(group.value)}
            >
              <div className="bg-background/95 sticky start-0 z-10 flex min-h-11 items-center backdrop-blur-sm">
                <button
                  aria-expanded={!collapsed}
                  className="hover:bg-muted/60 flex min-h-11 items-center gap-2 rounded-lg px-2 text-start transition-[background-color]"
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
                label: "Lane column counts",
                renderColumn: (column) => {
                  const columnRows = cellFor(column)?.rows.length ?? 0;
                  return (
                    <div
                      className="px-3"
                      data-kanban-lane-column-count={columnRows}
                    >
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatCount(columnRows)}
                      </span>
                    </div>
                  );
                },
                renderFoldedBand: (_band, span) => foldedCount(span, cells),
              })}

              {!collapsed &&
                renderRow({
                  className: "pb-1",
                  renderColumn: (column) => {
                    const cell = cellFor(column);
                    return cell === undefined ? null : (
                      <>
                        {renderCell({
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
            </section>
          );
        })}

        {footer}
      </div>
    </div>
  );
};

type FoldedBandSlotProps = {
  band: KanbanColumnBand;
  children: ReactNode;
  className: string;
  peek: BandPeekController;
};

/**
 * The narrow slot a folded band occupies in a row. Its pointer events go to
 * the board's peek controller, which decides when a resting pointer peeks
 * the band open and keeps a slot that appeared under the pointer folded.
 */
const FoldedBandSlot = ({
  band,
  children,
  className,
  peek,
}: FoldedBandSlotProps) => (
  <div
    className={className}
    data-kanban-band={band.id}
    data-kanban-band-collapsed=""
    onPointerMove={() => peek.slotPointerMove(band.id)}
    onPointerLeave={() => peek.slotPointerLeave(band.id)}
  >
    {children}
  </div>
);
