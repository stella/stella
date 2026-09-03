import { useRef, useState } from "react";

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { GripVerticalIcon, Rows3Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  KANBAN_VIRTUAL_CELL_PAGINATION,
  KanbanCellAction,
  KanbanColumnHeader,
  KanbanSubgroupBoard as KanbanSubgroupLayout,
  KanbanVirtualCell,
} from "@stll/ui/kanban";
import type {
  KanbanBoardCell,
  KanbanBoardMatrix,
  KanbanGroup,
} from "@stll/ui/kanban";
import type { OptionColor } from "@stll/ui/option-color";
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

type KanbanSubgroupBoardProps = {
  cardFields: string[];
  canMoveCards: boolean;
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
    sourceSubgroupValue: string | null | undefined,
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

/** Stella adapters around the reusable @stll/ui subgroup board. */
export const KanbanSubgroupBoard = ({
  cardFields,
  canMoveCards,
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

  return (
    <KanbanSubgroupLayout
      footer={
        hasMore ? (
          <div className="flex justify-center py-2">
            <Button
              disabled={isLoadingMore}
              onClick={onLoadMore}
              variant="outline"
            >
              {isLoadingMore ? t("common.loading") : t("common.loadMore")}
            </Button>
          </div>
        ) : null
      }
      formatCount={(count) => format.number(count)}
      matrix={matrix}
      renderCell={({ cell, laneValue }) => (
        <WorkspaceKanbanSubgroupCell
          canCreateTask={
            cell.coordinate.column.type === "group" &&
            cell.coordinate.column.group.value !== null &&
            canCreateTaskInLane(laneValue)
          }
          canMoveCards={canMoveCards}
          cardFields={cardFields}
          cell={cell}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          isTaskCreationPending={isTaskCreationPending}
          laneValue={laneValue}
          loadedEntityCount={loadedEntityCount}
          onCreateTask={onCreateTask}
          onDropCard={onDropCard}
          onLoadMore={onLoadMore}
          onRenameEntity={onRenameEntity}
          properties={properties}
          workspaceId={workspaceId}
        />
      )}
      renderColumnHeader={({ column, count }) =>
        column.type === "group" ? (
          <WorkspaceKanbanColumnHeading
            column={column.group}
            count={count}
            onChangeColor={onChangeColumnColor}
            onHide={onHideColumn}
            onRename={onRenameColumn}
            onReorder={onReorderColumn}
          />
        ) : (
          <KanbanColumnHeader title={column.destination.label} meta={count} />
        )
      }
      renderLaneIdentity={({ group }) => <SubgroupIdentity group={group} />}
    />
  );
};

type WorkspaceKanbanSubgroupCellProps = {
  canCreateTask: boolean;
  canMoveCards: boolean;
  cardFields: string[];
  cell: KanbanBoardCell<WorkspaceEntity>;
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
    sourceSubgroupValue: string | null | undefined,
  ) => void;
  onLoadMore: () => void;
  onRenameEntity: (entityId: string, newName: string) => void;
  properties: WorkspaceProperty[];
  workspaceId: string;
};

const WorkspaceKanbanSubgroupCell = ({
  canCreateTask,
  canMoveCards,
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
}: WorkspaceKanbanSubgroupCellProps) => {
  const cellRef = useRef<HTMLDivElement>(null);
  const columnValue =
    cell.coordinate.column.type === "group"
      ? cell.coordinate.column.group.value
      : null;
  const isDragOver = useKanbanEntityDropTarget({
    elementRef: cellRef,
    enabled: canMoveCards,
    name: `${cell.coordinate.column.type === "group" ? cell.coordinate.column.group.label : cell.coordinate.column.destination.label}, ${cell.coordinate.lane.type === "group" ? cell.coordinate.lane.group.label : ""}`,
    onDrop: (entityId, sourceSubgroupValue) => {
      if (columnValue !== null) {
        onDropCard(entityId, columnValue, laneValue, sourceSubgroupValue);
      }
    },
  });

  return (
    <KanbanVirtualCell
      accent={
        cell.coordinate.column.type === "group"
          ? cell.coordinate.column.group.optionColor
          : undefined
      }
      active={isDragOver}
      // The cell keeps its own bounded scroll surface, so it is the scroll
      // container its pinned action sticks in: the board's header offset
      // would push the action down past the first cards.
      className="[--kanban-sticky-top:0px]"
      containerRef={cellRef}
      footer={
        columnValue !== null && canCreateTask ? (
          <CreateTaskButton
            columnValue={columnValue}
            disabled={isTaskCreationPending}
            laneValue={laneValue}
            onCreate={onCreateTask}
          />
        ) : null
      }
      footerPlacement="sticky-start"
      getRowKey={(entity) => entity.entityId}
      pagination={
        hasMore
          ? {
              type: KANBAN_VIRTUAL_CELL_PAGINATION.CURSOR,
              hasMore,
              loading: isLoadingMore,
              pageKey: loadedEntityCount,
              onRequestMore: onLoadMore,
            }
          : { type: KANBAN_VIRTUAL_CELL_PAGINATION.NONE }
      }
      renderRow={(entity) => (
        <KanbanCard
          cardFields={cardFields}
          draggable={canMoveCards}
          dragSubgroupValue={laneValue}
          entity={entity}
          onRename={onRenameEntity}
          properties={properties}
          workspaceId={workspaceId}
        />
      )}
      rows={cell.rows}
    />
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
    <KanbanCellAction
      disabled={disabled}
      onClick={() => onCreate(columnValue, laneValue)}
    >
      {t("tasks.newTask")}
    </KanbanCellAction>
  );
};

type WorkspaceKanbanColumnHeadingProps = {
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

const WorkspaceKanbanColumnHeading = ({
  column,
  count,
  onChangeColor,
  onHide,
  onRename,
  onReorder,
}: WorkspaceKanbanColumnHeadingProps) => {
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
        "group/column relative w-full rounded-lg transition-opacity",
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
              if (columnValue !== null) {
                onChangeColor?.(columnValue, color);
              }
            }}
            optionColor={column.optionColor}
            showPicker={columnValue !== null && onChangeColor !== undefined}
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
      <span className="flex max-w-80 items-center gap-2">
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: group.color }}
        />
        <span className="truncate text-sm font-medium">{group.label}</span>
      </span>
    );
  }
  return (
    <span className="flex max-w-80 items-center gap-2">
      <Rows3Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate text-sm font-medium">{group.label}</span>
    </span>
  );
};
