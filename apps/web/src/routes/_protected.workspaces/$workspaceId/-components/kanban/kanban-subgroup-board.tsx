import { useState } from "react";

import { ChevronDownIcon, PlusIcon, Rows3Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import type { KanbanBoardMatrix, KanbanGroup } from "@stll/ui/kanban";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";

const KANBAN_CELL_WIDTH = "w-[300px]";

type KanbanSubgroupBoardProps = {
  cardFields: string[];
  hasMore: boolean;
  isLoadingMore: boolean;
  matrix: KanbanBoardMatrix<WorkspaceEntity>;
  canCreateTaskInLane: (laneValue: string | null) => boolean;
  onCreateTask: (columnValue: string, laneValue: string | null) => void;
  onLoadMore: () => void;
  onRenameEntity: (entityId: string, newName: string) => void;
  properties: WorkspaceProperty[];
  workspaceId: string;
};

/** A Notion-style swimlane board backed by one canonical placement matrix. */
export const KanbanSubgroupBoard = ({
  cardFields,
  canCreateTaskInLane,
  hasMore,
  isLoadingMore,
  matrix,
  onLoadMore,
  onCreateTask,
  onRenameEntity,
  properties,
  workspaceId,
}: KanbanSubgroupBoardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [collapsedLaneValues, setCollapsedLaneValues] = useState(
    () => new Set<string | null>(),
  );
  const [expandedEmptyLaneValues, setExpandedEmptyLaneValues] = useState(
    () => new Set<string | null>(),
  );

  const toggleLane = (value: string | null, isEmpty: boolean) => {
    if (isEmpty) {
      setExpandedEmptyLaneValues((current) => {
        const next = new Set(current);
        if (next.has(value)) {
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
      <div className="min-w-max">
        <div className="bg-background sticky top-0 z-20 flex gap-3 pb-3">
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
          const isEmpty = count === 0;
          const collapsed = isEmpty
            ? !expandedEmptyLaneValues.has(value)
            : collapsedLaneValues.has(value);

          return (
            <section
              className="border-border/60 border-b py-2 first:pt-0 last:border-b-0"
              key={value ?? "__uncategorized__"}
            >
              <div className="bg-background/95 sticky start-0 z-10 flex min-h-11 items-center backdrop-blur-sm">
                <button
                  aria-expanded={!collapsed}
                  className="hover:bg-muted/60 flex min-h-11 items-center gap-2 rounded-lg px-2 text-start transition-[background-color]"
                  onClick={() => toggleLane(value, isEmpty)}
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
                  {lane.group.color ? (
                    <span
                      className="size-5 shrink-0 rounded-md"
                      style={{ backgroundColor: lane.group.colorBg }}
                    >
                      <span
                        className="m-1.5 block size-2 rounded-full"
                        style={{ backgroundColor: lane.group.color }}
                      />
                    </span>
                  ) : (
                    <Rows3Icon className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <span className="max-w-80 truncate text-sm font-medium">
                    {lane.group.label}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {format.number(count)}
                  </span>
                </button>
              </div>

              {!collapsed && (
                <div className="flex gap-3 pb-1">
                  {laneCells.map((cell) => (
                    <div
                      className={cn(
                        KANBAN_CELL_WIDTH,
                        "bg-muted/20 min-h-20 shrink-0 space-y-2 rounded-xl p-2",
                      )}
                      key={cell.coordinate.column.value ?? "__uncategorized__"}
                      style={
                        cell.coordinate.column.colorBg
                          ? {
                              backgroundColor: `color-mix(in srgb, ${cell.coordinate.column.colorBg} 26%, transparent)`,
                            }
                          : undefined
                      }
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
                      {cell.rows.length === 0 &&
                        cell.coordinate.column.value !== null &&
                        canCreateTaskInLane(value) && (
                          <CreateTaskButton
                            columnValue={cell.coordinate.column.value}
                            laneValue={value}
                            onCreate={onCreateTask}
                          />
                        )}
                    </div>
                  ))}
                </div>
              )}
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

type CreateTaskButtonProps = {
  columnValue: string;
  laneValue: string | null;
  onCreate: (columnValue: string, laneValue: string | null) => void;
};

const CreateTaskButton = ({
  columnValue,
  laneValue,
  onCreate,
}: CreateTaskButtonProps) => {
  const t = useTranslations();

  return (
    <Button
      className="text-muted-foreground hover:text-foreground min-h-11 w-full justify-start gap-1.5"
      onClick={() => onCreate(columnValue, laneValue)}
      variant="ghost"
    >
      <PlusIcon className="size-3.5" />
      {t("tasks.newTask")}
    </Button>
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
        "bg-muted/25 flex min-h-14 shrink-0 items-center gap-2 rounded-xl px-3",
      )}
      style={
        column.colorBg
          ? {
              backgroundColor: `color-mix(in srgb, ${column.colorBg} 42%, transparent)`,
            }
          : undefined
      }
    >
      <span className="bg-background/55 flex min-w-0 items-center gap-2 rounded-md px-2 py-1 shadow-xs">
        {column.color && (
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: column.color }}
          />
        )}
        <span className="truncate text-sm font-medium">{column.label}</span>
      </span>
      <span className="text-muted-foreground ms-auto text-xs tabular-nums">
        {format.number(count)}
      </span>
    </div>
  );
};
