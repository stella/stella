import { useState } from "react";

import { ChevronDownIcon, Rows3Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import type { KanbanBoardMatrix, KanbanGroup } from "@stll/ui/kanban";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";

const SUBGROUP_LABEL_WIDTH = "w-44";
const KANBAN_CELL_WIDTH = "w-[300px]";

type KanbanSubgroupBoardProps = {
  cardFields: string[];
  hasMore: boolean;
  isLoadingMore: boolean;
  matrix: KanbanBoardMatrix<WorkspaceEntity>;
  onLoadMore: () => void;
  onRenameEntity: (entityId: string, newName: string) => void;
  properties: WorkspaceProperty[];
  workspaceId: string;
};

/** A Notion-style swimlane board backed by one canonical placement matrix. */
export const KanbanSubgroupBoard = ({
  cardFields,
  hasMore,
  isLoadingMore,
  matrix,
  onLoadMore,
  onRenameEntity,
  properties,
  workspaceId,
}: KanbanSubgroupBoardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [collapsedLaneValues, setCollapsedLaneValues] = useState(new Set());

  const toggleLane = (value: string | null) => {
    setCollapsedLaneValues((current) => {
      const next = new Set(current);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="min-w-max space-y-3">
        <div className="bg-background sticky top-0 z-20 flex gap-3 pb-2">
          <div className={cn(SUBGROUP_LABEL_WIDTH, "shrink-0")} />
          {matrix.columns.map((column) => (
            <ColumnHeading
              column={column}
              count={matrix.cells
                .filter((cell) => cell.coordinate.column.value === column.value)
                .reduce((sum, cell) => sum + cell.rows.length, 0)}
              key={column.value ?? "__uncategorized__"}
            />
          ))}
        </div>

        {matrix.lanes.map((lane) => {
          if (lane.type === "none") {
            return null;
          }
          const value = lane.group.value;
          const laneCells = matrix.cells.filter(
            (cell) =>
              cell.coordinate.lane.type === "group" &&
              cell.coordinate.lane.group.value === value,
          );
          const count = laneCells.reduce(
            (sum, cell) => sum + cell.rows.length,
            0,
          );
          const collapsed = collapsedLaneValues.has(value);

          return (
            <section
              className="border-border/70 overflow-hidden rounded-xl border"
              key={value ?? "__uncategorized__"}
            >
              <div className="flex gap-3">
                <div
                  className={cn(
                    SUBGROUP_LABEL_WIDTH,
                    "bg-muted/30 sticky start-0 z-10 shrink-0 border-e p-2",
                  )}
                >
                  <button
                    aria-expanded={!collapsed}
                    className="hover:bg-muted flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-start"
                    onClick={() => toggleLane(value)}
                    type="button"
                  >
                    <DirectionalIcon
                      className={cn(
                        "text-muted-foreground size-4 shrink-0 transition-transform",
                        collapsed && "-rotate-90",
                      )}
                      icon={ChevronDownIcon}
                    />
                    {lane.group.color ? (
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: lane.group.color }}
                      />
                    ) : (
                      <Rows3Icon className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {lane.group.label}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {format.number(count)}
                    </span>
                  </button>
                </div>

                {!collapsed &&
                  laneCells.map((cell) => (
                    <div
                      className={cn(
                        KANBAN_CELL_WIDTH,
                        "bg-muted/15 min-h-28 shrink-0 space-y-2 p-2",
                      )}
                      key={cell.coordinate.column.value ?? "__uncategorized__"}
                    >
                      {cell.rows.map((entity) => (
                        <KanbanCard
                          cardFields={cardFields}
                          draggable={false}
                          entity={entity}
                          key={entity.entityId}
                          onRename={onRenameEntity}
                          properties={properties}
                          workspaceId={workspaceId}
                        />
                      ))}
                    </div>
                  ))}

                {collapsed && (
                  <div className="text-muted-foreground flex min-h-14 flex-1 items-center px-3 text-xs">
                    {t("workspaces.kanban.collapsedSubgroup", {
                      count: String(count),
                    })}
                  </div>
                )}
              </div>
            </section>
          );
        })}

        {hasMore && (
          <div className="flex justify-center py-2">
            <Button
              disabled={isLoadingMore}
              onClick={onLoadMore}
              variant="outline"
            >
              {isLoadingMore ? t("common.loading") : t("common.loadMore")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

type ColumnHeadingProps = {
  column: KanbanGroup;
  count: number;
};

const ColumnHeading = ({ column, count }: ColumnHeadingProps) => {
  const format = useFormatter();

  return (
    <div
      className={cn(
        KANBAN_CELL_WIDTH,
        "bg-background flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3",
      )}
    >
      {column.color && (
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: column.color }}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {column.label}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {format.number(count)}
      </span>
    </div>
  );
};
