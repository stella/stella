import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { isTaskStatus, TASK_STATUS } from "@stll/api-contract";
import { UserText } from "@stll/ui/bidi-text";
import {
  buildKanbanBoardMatrix,
  KANBAN_BOARD_AUTO_SCROLL_SOURCES,
  registerKanbanBoardAutoScroll,
  KanbanColumnHeader,
  type KanbanBoardCell,
  KanbanSubgroupBoard,
  KanbanVirtualCell,
  resolveKanbanGrouping,
} from "@stll/ui/kanban";

import { stellaToast } from "@stll/ui/toast";

import { MatterRefLink } from "@/components/matter-ref-link";
import { useMountEffect } from "@/hooks/use-effect";
import { invalidateTaskQueries } from "@/lib/workspaces/mutations/tasks";
import { useRenameEntity } from "@/lib/workspaces/mutations/entities";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import type { ViewLayout } from "@/lib/types";
import { SignalCard } from "@/routes/_protected.inbox/-signal-card";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";
import { useKanbanEntityDropTarget } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/use-kanban-drop-targets";


import { ENTITY_VIEW_GROUP, entryId, entryGroupValue } from "./model";
import { NewEntityViewTask } from "./new-task";
import { useEntityViewGroupingSchema } from "./use-grouping-schema";
import type { EntityViewRow, EntityViewScope } from "./types";

type PlacedRow = { row: EntityViewRow; lane: string | null };
type MoveTaskOptions = {
  entityId: string;
  status: string | null;
  sourceLane: string | null | undefined;
  targetLane: string | null;
};

type EntityViewKanbanProps = {
  organizationId: string;
  scope: EntityViewScope;
  rows: EntityViewRow[];
  layout: Extract<ViewLayout, { type: "kanban" }>;
  onChanged: () => Promise<void>;
};

export const EntityViewKanban = ({ organizationId, scope, rows, layout, onChanged }: EntityViewKanbanProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rename = useRenameEntity();
  const queryClient = useQueryClient();
  useMountEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    return registerKanbanBoardAutoScroll({ element, sources: KANBAN_BOARD_AUTO_SCROLL_SOURCES.elements });
  });
  const canUpdate = usePermissions({ entity: ["update"] });
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const sourceSchema = useEntityViewGroupingSchema(rows);
  const schema = {
    ...sourceSchema,
    builtInGroups: sourceSchema.builtInGroups.map((group) => ({
      ...group,
      selectRows: (items: readonly PlacedRow[]) => [...items],
    })),
  };
  const groupId = layout.groupByPropertyId ?? ENTITY_VIEW_GROUP.STATUS;
  const subgroupId = layout.subgroupByPropertyId ?? "";
  const placed: PlacedRow[] = [];
  for (const row of rows) {
    if (subgroupId !== ENTITY_VIEW_GROUP.ASSIGNEE) {
      placed.push({ row, lane: entryGroupValue(row.entry, subgroupId) });
      continue;
    }
    const users = row.entry.type === "entity"
      ? row.entry.entity.assignees.map((assignee) => assignee.userId)
      : row.entry.signal.assigneeUserId ? [row.entry.signal.assigneeUserId] : [];
    if (users.length === 0) placed.push({ row, lane: null });
    for (const userId of users) placed.push({ row, lane: userId });
  }
  const matrix = buildKanbanBoardMatrix({
    rows: placed,
    group: resolveKanbanGrouping({ groupBy: groupId, schema }),
    subgroup: resolveKanbanGrouping({ groupBy: subgroupId, schema }),
    uncategorizedLabel: t("inbox.unassigned"),
    resolveGroupValue: ({ grouping, row }) => grouping.type === "none" ? null : grouping.propertyId === subgroupId ? row.lane : entryGroupValue(row.row.entry, grouping.propertyId),
  });

  const move = async ({ entityId, status, sourceLane, targetLane }: MoveTaskOptions) => {
    const entry = rows.find((row) => row.entry.type === "entity" && row.entry.entity.entityId === entityId)?.entry;
    if (!entry || entry.type !== "entity" || !canUpdate || entry.entity.readOnly || entry.entity.kind !== "task" || !isTaskStatus(status) || pendingRef.current.has(entityId)) return;
    if (subgroupId && subgroupId !== ENTITY_VIEW_GROUP.ASSIGNEE && entryGroupValue(entry, subgroupId) !== targetLane) return;
    pendingRef.current.add(entityId);
    setPending(new Set(pendingRef.current));
    const result = await Result.tryPromise(async () => {
      const taskApi = api.tasks({ workspaceId: toSafeId<"workspace">(entry.workspaceId) });
      if (entry.entity.status !== status) {
        unwrapEden(await taskApi.patch({ taskId: toSafeId<"entity">(entityId), status }));
      }
      if (subgroupId === ENTITY_VIEW_GROUP.ASSIGNEE && sourceLane !== undefined && sourceLane !== targetLane) {
        unwrapEden(await taskApi.assignees.move.post({
          taskId: toSafeId<"entity">(entityId),
          fromUserId: sourceLane === null ? null : toSafeId<"user">(sourceLane),
          toUserId: targetLane === null ? null : toSafeId<"user">(targetLane),
        }));
      }
    });
    if (result.isErr()) {
      analytics.captureError(result.error);
      stellaToast.error(userErrorFromThrown(result.error, t("common.unexpectedError")));
    }
    await invalidateTaskQueries({ queryClient, workspaceId: entry.workspaceId, taskId: entityId });
    pendingRef.current.delete(entityId);
    setPending(new Set(pendingRef.current));
  };

  const renderCellFooter = (cell: KanbanBoardCell<PlacedRow>, laneValue: string | null) => {
    const { column } = cell.coordinate;
    if (column.type !== "group" || subgroupId === ENTITY_VIEW_GROUP.AUTHOR) return null;
    if (subgroupId === ENTITY_VIEW_GROUP.TYPE && laneValue !== "task" && laneValue !== "deadline") return null;
    if (subgroupId === ENTITY_VIEW_GROUP.KIND && laneValue !== "task") return null;
    if (subgroupId === ENTITY_VIEW_GROUP.MATTER && laneValue === null) return null;
    const status = isTaskStatus(column.group.value)
      ? column.group.value
      : groupId === ENTITY_VIEW_GROUP.KIND && column.group.value === "task"
        ? TASK_STATUS.OPEN : null;
    if (!status) return null;
    return <NewEntityViewTask
      organizationId={organizationId}
      workspaceId={subgroupId === ENTITY_VIEW_GROUP.MATTER ? laneValue : scope.type === "matter" ? scope.matterId : null}
      status={status}
      assigneeUserId={subgroupId === ENTITY_VIEW_GROUP.ASSIGNEE ? laneValue : undefined}
      agendaKind={subgroupId === ENTITY_VIEW_GROUP.TYPE && laneValue === "deadline" ? "deadline" : "task"}
      onChanged={onChanged}
    />;
  };

  return <KanbanSubgroupBoard
    className="min-h-0 flex-1"
    scrollRef={scrollRef}
    matrix={matrix}
    formatCount={(count) => format.number(count)}
    renderColumnHeader={({ column, count }) => column.type === "group"
      ? <KanbanColumnHeader title={<UserText>{column.group.label}</UserText>} meta={format.number(count)} />
      : null}
    renderLaneIdentity={({ group }) => <UserText>{group.label}</UserText>}
    renderCell={({ cell, laneValue }) => <EntityViewKanbanCell
      organizationId={organizationId}
      cell={cell}
      footer={renderCellFooter(cell, laneValue)}
      laneValue={laneValue}
      enabled={canUpdate && groupId === ENTITY_VIEW_GROUP.STATUS}
      canEdit={canUpdate}
      onChanged={onChanged}
      pending={pending}
      canDrop={(id) => {
        const entry = rows.find((row) => row.entry.type === "entity" && row.entry.entity.entityId === id)?.entry;
        return entry?.type === "entity" && entry.entity.kind === "task" && !entry.entity.readOnly && !pending.has(id) && (!subgroupId || subgroupId === ENTITY_VIEW_GROUP.ASSIGNEE || entryGroupValue(entry, subgroupId) === laneValue);
      }}
      onRename={(workspaceId, entityId, name) => rename.mutate({ workspaceId, entityId, name }, { onSuccess: () => detached(onChanged(), "entity-view.rename") })}
      onDrop={(id, sourceLane) => detached(move({ entityId: id, status: cell.coordinate.column.type === "group" ? cell.coordinate.column.group.value : null, sourceLane, targetLane: laneValue }), "entity-view.move")}
    />}
  />;
};

type EntityViewKanbanCellProps = {
  organizationId: string;
  cell: KanbanBoardCell<PlacedRow>;
  footer: ReactNode;
  laneValue: string | null;
  enabled: boolean;
  canEdit: boolean;
  onChanged: () => Promise<void>;
  pending: ReadonlySet<string>;
  canDrop: (entityId: string) => boolean;
  onRename: (workspaceId: string, entityId: string, name: string) => void;
  onDrop: (entityId: string, sourceLane: string | null | undefined) => void;
};
const EntityViewKanbanCell = ({ organizationId, cell, footer, laneValue, enabled, canEdit, pending, onDrop, onRename, canDrop, onChanged }: EntityViewKanbanCellProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const group = cell.coordinate.column.type === "group" ? cell.coordinate.column.group : null;
  const active = useKanbanEntityDropTarget({ elementRef: ref, name: group?.label ?? "", enabled, canDrop, onDrop });
  return <div ref={ref} className="min-h-24">
    <KanbanVirtualCell
      rows={cell.rows}
      getRowKey={({ row }) => entryId(row.entry)}
      pagination={{ type: "none" }}
      accent={group?.optionColor}
      active={active}
      footer={footer}
      footerPlacement="end"
      renderRow={({ row }) => row.entry.type === "proposal" ? <SignalCard signal={row.entry.signal} organizationId={organizationId} onChanged={onChanged} /> : <div className={pending.has(row.entry.entity.entityId) ? "pointer-events-none opacity-60" : undefined}>
        <KanbanCard entity={row.entry.entity} workspaceId={row.entry.workspaceId} draggable={enabled && row.entry.entity.kind === "task" && !row.entry.entity.readOnly} dragSubgroupValue={laneValue}
          onRename={canEdit && !row.entry.entity.readOnly ? (entityId, name) => { if (row.entry.type === "entity") onRename(row.entry.workspaceId, entityId, name); } : undefined}
          context={<span className="text-muted-foreground text-xs"><MatterRefLink workspaceId={row.entry.workspaceId}>{row.entry.workspaceName}</MatterRefLink></span>}
        />
      </div>}
    />
  </div>;
};
