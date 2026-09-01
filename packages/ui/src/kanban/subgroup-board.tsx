import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ChevronDownIcon } from "lucide-react";

import { DirectionalIcon } from "../components/directional-icon";
import { cn } from "../lib/utils";
import type { KanbanGroup } from "./grouping";
import type { KanbanBoardCell, KanbanBoardMatrix } from "./matrix";

const groupValueKey = (value: string | null): string =>
  value === null ? "null" : `value:${value.length}:${value}`;

export type KanbanSubgroupColumnHeaderContext = {
  column: KanbanGroup;
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
  formatCount?: ((count: number) => ReactNode) | undefined;
  footer?: ReactNode;
  className?: string | undefined;
} & KanbanSubgroupCollapseControl;

/** Reusable swimlane layout over the canonical two-axis Kanban matrix. */
export const KanbanSubgroupBoard = <TRow,>({
  matrix,
  renderColumnHeader,
  renderLaneIdentity,
  renderCell,
  formatCount = String,
  isLaneCollapsed,
  onLaneCollapsedChange,
  footer,
  className,
}: KanbanSubgroupBoardProps<TRow>) => {
  const [collapsedLaneValues, setCollapsedLaneValues] = useState(
    () => new Set<string | null>(),
  );
  const [expandedEmptyLaneValues, setExpandedEmptyLaneValues] = useState(
    () => new Set<string | null>(),
  );
  const { cellsByLaneValue, countByColumnValue } = useMemo(() => {
    const laneCells = new Map<string | null, KanbanBoardCell<TRow>[]>();
    const columnCounts = new Map<string | null, number>();
    for (const cell of matrix.cells) {
      columnCounts.set(
        cell.coordinate.column.value,
        (columnCounts.get(cell.coordinate.column.value) ?? 0) +
          cell.rows.length,
      );
      if (cell.coordinate.lane.type === "none") {
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
    };
  }, [matrix.cells]);

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

  return (
    <div className={cn("h-full overflow-auto px-4 pb-4", className)}>
      <div className="min-w-max">
        <div className="bg-background sticky top-0 z-20 flex gap-3 pt-4 pb-3">
          {matrix.columns.map((column) => (
            <div
              className="w-[300px] shrink-0"
              key={groupValueKey(column.value)}
            >
              {renderColumnHeader({
                column,
                count: countByColumnValue.get(column.value) ?? 0,
              })}
            </div>
          ))}
        </div>

        {matrix.lanes.map((lane) => {
          if (lane.type === "none") {
            return null;
          }
          const { group } = lane;
          const cells = cellsByLaneValue.get(group.value) ?? [];
          const count = cells.reduce((sum, cell) => sum + cell.rows.length, 0);
          const defaultCollapsed =
            count === 0
              ? !expandedEmptyLaneValues.has(group.value)
              : collapsedLaneValues.has(group.value);
          const collapsed = isLaneCollapsed
            ? isLaneCollapsed(group, count)
            : defaultCollapsed;

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

              {!collapsed && (
                <div className="flex gap-3 pb-1">
                  {cells.map((cell) => (
                    <div
                      className="w-[300px] shrink-0"
                      key={groupValueKey(cell.coordinate.column.value)}
                    >
                      {renderCell({
                        cell,
                        count: cell.rows.length,
                        laneValue: group.value,
                      })}
                    </div>
                  ))}
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
