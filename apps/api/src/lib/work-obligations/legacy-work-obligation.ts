import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  taskAssignees,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
  workObligationEvents,
  workObligations,
  workspaceMembers,
} from "@/api/db/schema";
import type {
  WorkObligationSource,
  WorkObligationStatus,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  AGENDA_ITEM_SOURCE,
  AGENDA_ITEM_SOURCES,
} from "@/api/lib/entity-constants";
import type { AgendaItemSource } from "@/api/lib/entity-constants";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";
import { isWorkObligationEligible } from "@/api/lib/work-obligations/eligibility";

/**
 * How a pre-governance task's `agenda_source` reads as governed provenance.
 * Total over the legacy value list, so a new agenda source has to decide its
 * provenance instead of silently landing on `manual`.
 */
const LEGACY_AGENDA_WORK_OBLIGATION_SOURCE = {
  [AGENDA_ITEM_SOURCE.MANUAL]: WORK_OBLIGATION_SOURCE.MANUAL,
  [AGENDA_ITEM_SOURCE.INFOSOUD]: WORK_OBLIGATION_SOURCE.COURT,
  [AGENDA_ITEM_SOURCE.CALENDAR]: WORK_OBLIGATION_SOURCE.CALENDAR,
  [AGENDA_ITEM_SOURCE.EMAIL]: WORK_OBLIGATION_SOURCE.EMAIL,
  [AGENDA_ITEM_SOURCE.IMPORT]: WORK_OBLIGATION_SOURCE.IMPORT,
  [AGENDA_ITEM_SOURCE.API]: WORK_OBLIGATION_SOURCE.API,
} as const satisfies Record<AgendaItemSource, WorkObligationSource>;

type LegacyTask = {
  id: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  agendaKind: string | null;
  agendaSource: string | null;
  status: string | null;
  dueDate: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date | null;
  assigneeUserIds: SafeId<"user">[];
};

export const legacyWorkObligationValues = (task: LegacyTask) => {
  let status: WorkObligationStatus = WORK_OBLIGATION_STATUS.UNASSIGNED;
  if (task.status === "done") {
    status = WORK_OBLIGATION_STATUS.COMPLETED;
  } else if (task.status === "cancelled") {
    status = WORK_OBLIGATION_STATUS.CANCELLED;
  } else if (task.assigneeUserIds.length === 1) {
    status = WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT;
  }

  const ownerUserId =
    task.assigneeUserIds.length === 1 ? task.assigneeUserIds[0] : null;

  const sourceType =
    task.agendaSource !== null &&
    includes(AGENDA_ITEM_SOURCES, task.agendaSource)
      ? LEGACY_AGENDA_WORK_OBLIGATION_SOURCE[task.agendaSource]
      : WORK_OBLIGATION_SOURCE.MANUAL;

  const isDeadline = task.agendaKind === WORK_OBLIGATION_TYPE.DEADLINE;
  return {
    entityId: task.id,
    workspaceId: task.workspaceId,
    type: isDeadline
      ? WORK_OBLIGATION_TYPE.DEADLINE
      : WORK_OBLIGATION_TYPE.TASK,
    status,
    ownerUserId,
    workingTargetDate: task.dueDate,
    hardDeadlineDate: isDeadline ? task.dueDate : null,
    sourceType,
    createdByUserId: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt ?? task.createdAt,
  };
};

type LegacyCreatedEventRow = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  createdByUserId: string | null;
};

/**
 * The obligation carries no history of its own: the legacy task predates
 * governance. One `created` event, stamped at insertion rather than at the
 * task's original creation, keeps the timeline honest about when the governed
 * record actually began.
 */
export const legacyWorkObligationCreatedEvents = (
  rows: LegacyCreatedEventRow[],
  occurredAt: Date,
): (typeof workObligationEvents.$inferInsert)[] =>
  rows.map((row) => ({
    id: createSafeId<"workObligationEvent">(),
    workspaceId: row.workspaceId,
    obligationEntityId: row.entityId,
    actorUserId: row.createdByUserId,
    type: WORK_OBLIGATION_EVENT_TYPE.CREATED,
    details: { type: "created", cause: "legacy_backfill" },
    occurredAt,
  }));

type EnsureLegacyWorkObligationOptions = {
  tx: Transaction;
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

/** Compatibility bridge while the bounded repair sweep converges. */
export const ensureLegacyWorkObligation = async ({
  tx,
  entityId,
  workspaceId,
}: EnsureLegacyWorkObligationOptions): Promise<void> => {
  await lockWorkspacesForEntityCap(tx, [workspaceId]);

  const tasks = await tx
    .select({
      id: entities.id,
      workspaceId: entities.workspaceId,
      listItemType: entities.listItemType,
      agendaKind: entities.agendaKind,
      agendaSource: entities.agendaSource,
      status: entities.status,
      dueDate: entities.dueDate,
      createdBy: entities.createdBy,
      createdAt: entities.createdAt,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        eq(entities.workspaceId, workspaceId),
        eq(entities.kind, "task"),
      ),
    )
    .limit(1)
    .for("update");
  const task = tasks.at(0);
  if (!task || !isWorkObligationEligible(task.listItemType)) {
    return;
  }

  const assignments = await tx
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, taskAssignees.workspaceId),
        eq(workspaceMembers.userId, taskAssignees.userId),
      ),
    )
    .where(
      and(
        eq(taskAssignees.entityId, entityId),
        eq(taskAssignees.workspaceId, workspaceId),
      ),
    )
    .limit(2)
    .for("update", { of: workspaceMembers });

  const inserted = await tx
    .insert(workObligations)
    .values(
      legacyWorkObligationValues({
        ...task,
        assigneeUserIds: assignments.map((assignment) =>
          brandPersistedUserId(assignment.userId),
        ),
      }),
    )
    .onConflictDoNothing({ target: workObligations.entityId })
    .returning({
      entityId: workObligations.entityId,
      workspaceId: workObligations.workspaceId,
      createdByUserId: workObligations.createdByUserId,
    });
  if (inserted.length === 0) {
    return;
  }

  await tx
    .insert(workObligationEvents)
    .values(legacyWorkObligationCreatedEvents(inserted, new Date()));
};
