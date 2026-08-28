import { type UIEvent, useRef, useState } from "react";

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDownIcon,
  GripVerticalIcon,
  PlusIcon,
  Rows3Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { OptionColor } from "@stll/api/types";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { KanbanColumnHeader } from "@stll/ui/kanban";
import type { KanbanBoardMatrix, KanbanGroup } from "@stll/ui/kanban";
import { cn } from "@stll/ui/utils";

import { UserIdentity } from "@/components/user-avatar";
import { useFormatter } from "@/i18n/formatting-context";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";
import {
  KanbanColumnActions,
  KanbanColumnSwatch,
  KanbanColumnTitle,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import {
  useKanbanColumnDrag,
  useKanbanEntityDropTarget,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/use-kanban-drop-targets";

const KANBAN_CELL_WIDTH = "w-[300px]";
const KANBAN_CARD_ESTIMATE_PX = 128;
const KANBAN_CARD_OVERSCAN = 8;
const KANBAN_LOAD_MORE_THRESHOLD_PX = 200;

type KanbanSubgroupBoardProps = {
  cardFields: string[];
  canDropCards: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  isTaskCreationPending: boolean;
  loadedEntityCount: number;
  matrix: KanbanBoardMatrix<WorkspaceEntity>;
  canCreateTaskInLane: (laneValue: string | null) => boolean;
  onChangeColumnColor?:
    | ((columnValue: string, color: OptionColor) => void)
    | undefined;
  onCreateTask: (columnValue: string, laneValue: string | null) => void;
  onDropCard: (
    entityId: string,
    columnValue: string,
    laneValue: string | null,
  ) => void;
  onHideColumn: (columnValue: string) => void;
  onLoadMore: () => void;
  onRenameColumn?:
    | ((columnValue: string, newValue: string) => void)
    | undefined;
  onRenameEntity: (entityId: string, newName: string) => void;
  onReorderColumn: (
    sourceValue: string,
    targetValue: string,
    edge: Edge | null,
  ) => void;
  properties: WorkspaceProperty[];
  workspaceId: string;
};

/** A Notion-style swimlane board backed by one canonical placement matrix. */
export const KanbanSubgroupBoard = ({
  cardFields,
  canDropCards,
  canCreateTaskInLane,
  hasMore,
  isLoadingMore,
  isTaskCreationPending,
  loadedEntityCount,
  matrix,
  onChangeColumnColor,
  onLoadMore,
  onCreateTask,
  onDropCard,
  onHideColumn,
  onRenameColumn,
  onRenameEntity,
  onReorderColumn,
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
    <div className="h-full overflow-auto px-4 pb-4">
      <div className="min-w-max">
        <div className="bg-background sticky top-0 z-20 flex gap-3 pt-4 pb-3">
          {matrix.columns.map((column) => (
            <ColumnHeading
              column={column}
              count={matrix.cells
                .filter((cell) => cell.coordinate.column.value === column.value)
                .reduce((sum, cell) => sum + cell.rows.length, 0)}
              key={column.value ?? "__uncategorized__"}
              onChangeColor={onChangeColumnColor}
              onHide={onHideColumn}
              onRename={onRenameColumn}
              onReorder={onReorderColumn}
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
                  <SubgroupIdentity group={lane.group} />
                  {lane.group.image === undefined && (
                    <span className="max-w-80 truncate text-sm font-medium">
                      {lane.group.label}
                    </span>
                  )}
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {format.number(count)}
                  </span>
                </button>
              </div>

              {!collapsed && (
                <div className="flex gap-3 pb-1">
                  {laneCells.map((cell) => (
                    <KanbanSubgroupCell
                      canCreateTask={
                        cell.coordinate.column.value !== null &&
                        canCreateTaskInLane(value)
                      }
                      canDropCards={canDropCards}
                      cardFields={cardFields}
                      cell={cell}
                      hasMore={hasMore}
                      isLoadingMore={isLoadingMore}
                      isTaskCreationPending={isTaskCreationPending}
                      key={cell.coordinate.column.value ?? "__uncategorized__"}
                      laneValue={value}
                      loadedEntityCount={loadedEntityCount}
                      onCreateTask={onCreateTask}
                      onDropCard={onDropCard}
                      onLoadMore={onLoadMore}
                      onRenameEntity={onRenameEntity}
                      properties={properties}
                      workspaceId={workspaceId}
                    />
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

type KanbanSubgroupCellProps = {
  canCreateTask: boolean;
  canDropCards: boolean;
  cardFields: string[];
  cell: KanbanBoardMatrix<WorkspaceEntity>["cells"][number];
  hasMore: boolean;
  isLoadingMore: boolean;
  isTaskCreationPending: boolean;
  laneValue: string | null;
  loadedEntityCount: number;
  onCreateTask: (columnValue: string, laneValue: string | null) => void;
  onDropCard: (
    entityId: string,
    columnValue: string,
    laneValue: string | null,
  ) => void;
  onLoadMore: () => void;
  onRenameEntity: (entityId: string, newName: string) => void;
  properties: WorkspaceProperty[];
  workspaceId: string;
};

const KanbanSubgroupCell = ({
  canCreateTask,
  canDropCards,
  cardFields,
  cell,
  hasMore,
  isLoadingMore,
  isTaskCreationPending,
  laneValue,
  loadedEntityCount,
  onCreateTask,
  onDropCard,
  onLoadMore,
  onRenameEntity,
  properties,
  workspaceId,
}: KanbanSubgroupCellProps) => {
  const cellRef = useRef<HTMLDivElement>(null);
  const requestedAtEntityCountRef = useRef<number | null>(null);
  const columnValue = cell.coordinate.column.value;
  const cardVirtualizer = useVirtualizer({
    count: cell.rows.length,
    estimateSize: () => KANBAN_CARD_ESTIMATE_PX,
    getItemKey: (index) => cell.rows.at(index)?.entityId ?? index,
    getScrollElement: () => cellRef.current,
    overscan: KANBAN_CARD_OVERSCAN,
  });
  const virtualCards = cardVirtualizer.getVirtualItems();
  const isDragOver = useKanbanEntityDropTarget({
    elementRef: cellRef,
    enabled: canDropCards,
    name: `${cell.coordinate.column.label}, ${cell.coordinate.lane.type === "group" ? cell.coordinate.lane.group.label : ""}`,
    onDrop: (entityId) => {
      if (columnValue !== null) {
        onDropCard(entityId, columnValue, laneValue);
      }
    },
  });

  const handleScroll = ({ currentTarget }: UIEvent<HTMLDivElement>) => {
    if (!hasMore || isLoadingMore) {
      return;
    }
    const remaining =
      currentTarget.scrollHeight -
      currentTarget.scrollTop -
      currentTarget.clientHeight;
    if (remaining > KANBAN_LOAD_MORE_THRESHOLD_PX) {
      return;
    }
    if (requestedAtEntityCountRef.current === loadedEntityCount) {
      return;
    }
    requestedAtEntityCountRef.current = loadedEntityCount;
    onLoadMore();
  };

  return (
    <div
      className={cn(
        KANBAN_CELL_WIDTH,
        "bg-muted/20 max-h-[min(60vh,40rem)] min-h-20 shrink-0 overflow-y-auto overscroll-y-contain rounded-xl p-2 transition-[background-color,outline-color]",
        isDragOver && "bg-primary/5 ring-primary/50 ring-2",
      )}
      onScroll={handleScroll}
      ref={cellRef}
      style={
        cell.coordinate.column.colorBg
          ? {
              backgroundColor: `color-mix(in srgb, ${cell.coordinate.column.colorBg} 26%, transparent)`,
            }
          : undefined
      }
    >
      <div
        className="relative"
        style={{ height: cardVirtualizer.getTotalSize() }}
      >
        {virtualCards.map((virtualCard) => {
          const entity = cell.rows.at(virtualCard.index);
          if (!entity) {
            return null;
          }

          return (
            <div
              className="absolute inset-x-0 top-0 pb-2"
              data-index={virtualCard.index}
              key={entity.entityId}
              ref={cardVirtualizer.measureElement}
              style={{ transform: `translateY(${virtualCard.start}px)` }}
            >
              <KanbanCard
                cardFields={cardFields}
                draggable={canDropCards}
                entity={entity}
                onRename={onRenameEntity}
                properties={properties}
                workspaceId={workspaceId}
              />
            </div>
          );
        })}
      </div>
      {columnValue !== null && canCreateTask && (
        <CreateTaskButton
          columnValue={columnValue}
          disabled={isTaskCreationPending}
          laneValue={laneValue}
          onCreate={onCreateTask}
        />
      )}
    </div>
  );
};

type CreateTaskButtonProps = {
  columnValue: string;
  disabled: boolean;
  laneValue: string | null;
  onCreate: (columnValue: string, laneValue: string | null) => void;
};

const CreateTaskButton = ({
  columnValue,
  disabled,
  laneValue,
  onCreate,
}: CreateTaskButtonProps) => {
  const t = useTranslations();

  return (
    <Button
      className="text-muted-foreground hover:text-foreground min-h-11 w-full justify-start gap-1.5"
      disabled={disabled}
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
  onChangeColor?:
    | ((columnValue: string, color: OptionColor) => void)
    | undefined;
  onHide: (columnValue: string) => void;
  onRename?: ((columnValue: string, newValue: string) => void) | undefined;
  onReorder: (
    sourceValue: string,
    targetValue: string,
    edge: Edge | null,
  ) => void;
};

const ColumnHeading = ({
  column,
  count,
  onChangeColor,
  onHide,
  onRename,
  onReorder,
}: ColumnHeadingProps) => {
  const format = useFormatter();
  const headingRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(column.label);
  const columnValue = column.value;
  const canEdit = columnValue !== null;
  const { closestEdge, isDragging } = useKanbanColumnDrag({
    columnValue,
    dragHandleRef,
    elementRef: headingRef,
    name: column.label,
    onDrop: onReorder,
    reorderEnabled: canEdit,
  });

  const commitRename = () => {
    setEditing(false);
    const value = editValue.trim();
    if (columnValue !== null && value && value !== column.label) {
      onRename?.(columnValue, value);
    }
  };

  return (
    <div
      className={cn(
        KANBAN_CELL_WIDTH,
        "group/column relative shrink-0 rounded-lg transition-opacity",
        !column.colorBg && "bg-muted/50",
        isDragging && "opacity-40",
      )}
      ref={headingRef}
      style={
        column.colorBg
          ? {
              backgroundColor: `color-mix(in srgb, ${column.colorBg} 50%, transparent)`,
            }
          : undefined
      }
    >
      {closestEdge && !isDragging && (
        <div
          className={cn(
            "bg-primary pointer-events-none absolute top-0 z-10 h-full w-0.5",
            closestEdge === "left" ? "-start-[7px]" : "-end-[7px]",
          )}
        />
      )}
      <KanbanColumnHeader
        actions={
          <KanbanColumnActions
            entityCount={count}
            onChangeColor={
              columnValue !== null && onChangeColor
                ? (color) => onChangeColor(columnValue, color)
                : undefined
            }
            onHideColumn={
              columnValue !== null ? () => onHide(columnValue) : undefined
            }
            optionColor={column.optionColor}
            title={column.label}
          />
        }
        dragHandle={
          canEdit ? (
            <div
              className="text-muted-foreground hover:text-foreground shrink-0 cursor-grab opacity-0 transition-opacity group-hover/column:opacity-100"
              ref={dragHandleRef}
            >
              <GripVerticalIcon className="size-3.5" />
            </div>
          ) : null
        }
        meta={format.number(count)}
        swatch={
          <KanbanColumnSwatch
            color={column.color}
            onSelect={(color) => {
              if (column.value !== null) {
                onChangeColor?.(column.value, color);
              }
            }}
            optionColor={column.optionColor}
            showPicker={column.value !== null && onChangeColor !== undefined}
          />
        }
        title={
          <KanbanColumnTitle
            editValue={editValue}
            editing={editing}
            onCancel={() => {
              setEditing(false);
              setEditValue(column.label);
            }}
            onChange={setEditValue}
            onCommit={commitRename}
            onStartEditing={
              canEdit && onRename
                ? () => {
                    setEditValue(column.label);
                    setEditing(true);
                  }
                : undefined
            }
            title={column.label}
          />
        }
      />
    </div>
  );
};

const SubgroupIdentity = ({ group }: { group: KanbanGroup }) => {
  if (group.image !== undefined) {
    return (
      <UserIdentity
        as="span"
        avatarClassName="size-5 shrink-0 text-[0.5rem]"
        className="max-w-80 gap-2"
        image={group.image}
        name={group.label}
        nameClassName="text-sm font-medium"
      />
    );
  }
  if (group.color) {
    return (
      <span
        className="size-5 shrink-0 rounded-md"
        style={{ backgroundColor: group.colorBg }}
      >
        <span
          className="m-1.5 block size-2 rounded-full"
          style={{ backgroundColor: group.color }}
        />
      </span>
    );
  }
  return <Rows3Icon className="text-muted-foreground size-4 shrink-0" />;
};
