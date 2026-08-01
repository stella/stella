import type { Transaction } from "@/api/db/root";
import {
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { AgendaItemKind, TaskStatus } from "@/api/lib/entity-constants";
import { TASK_STATUS } from "@/api/lib/entity-constants";

type CreateWorkObligationOptions = {
  tx: Transaction;
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  actorUserId: SafeId<"user">;
  ownerUserId: SafeId<"user">;
  agendaKind: AgendaItemKind;
  taskStatus: TaskStatus;
  workingTargetDate: string | null;
  hardDeadlineDate: string | null;
  sourceDescription?: string | null;
};

/**
 * Attach governed operational state to a newly-created task. Creation and its
 * activity events must remain in the caller's entity transaction.
 */
export const createWorkObligation = async ({
  tx,
  entityId,
  workspaceId,
  actorUserId,
  ownerUserId,
  agendaKind,
  taskStatus,
  workingTargetDate,
  hardDeadlineDate,
  sourceDescription,
}: CreateWorkObligationOptions) => {
  const now = new Date();
  const isSelfAssigned = actorUserId === ownerUserId;
  const assignedStatus = isSelfAssigned
    ? WORK_OBLIGATION_STATUS.ACTIVE
    : WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT;
  const status = (() => {
    if (taskStatus === TASK_STATUS.DONE) {
      return WORK_OBLIGATION_STATUS.COMPLETED;
    }
    if (taskStatus === TASK_STATUS.CANCELLED) {
      return WORK_OBLIGATION_STATUS.CANCELLED;
    }
    return assignedStatus;
  })();

  await tx.insert(workObligations).values({
    entityId,
    workspaceId,
    type:
      agendaKind === "deadline"
        ? WORK_OBLIGATION_TYPE.DEADLINE
        : WORK_OBLIGATION_TYPE.TASK,
    status,
    ownerUserId,
    acknowledgedAt: isSelfAssigned ? now : null,
    acknowledgedByUserId: isSelfAssigned ? actorUserId : null,
    workingTargetDate,
    hardDeadlineDate,
    sourceType: "manual",
    sourceDescription: sourceDescription ?? null,
    createdByUserId: actorUserId,
  });

  const events: (typeof workObligationEvents.$inferInsert)[] = [
    {
      id: createSafeId<"workObligationEvent">(),
      workspaceId,
      obligationEntityId: entityId,
      actorUserId,
      type: WORK_OBLIGATION_EVENT_TYPE.CREATED,
      details: { type: "created" },
      occurredAt: now,
    },
    {
      id: createSafeId<"workObligationEvent">(),
      workspaceId,
      obligationEntityId: entityId,
      actorUserId,
      type: WORK_OBLIGATION_EVENT_TYPE.OWNER_ASSIGNED,
      details: {
        type: "ownership_changed",
        previousOwnerUserId: null,
        nextOwnerUserId: ownerUserId,
      },
      occurredAt: now,
    },
  ];
  if (isSelfAssigned) {
    events.push({
      id: createSafeId<"workObligationEvent">(),
      workspaceId,
      obligationEntityId: entityId,
      actorUserId,
      type: WORK_OBLIGATION_EVENT_TYPE.ACKNOWLEDGED,
      details: { type: "acknowledged" },
      occurredAt: now,
    });
  }
  if (status === WORK_OBLIGATION_STATUS.COMPLETED) {
    events.push({
      id: createSafeId<"workObligationEvent">(),
      workspaceId,
      obligationEntityId: entityId,
      actorUserId,
      type: WORK_OBLIGATION_EVENT_TYPE.COMPLETED,
      details: {
        type: "status_changed",
        previousStatus: assignedStatus,
        nextStatus: status,
      },
      occurredAt: now,
    });
  }
  if (status === WORK_OBLIGATION_STATUS.CANCELLED) {
    events.push({
      id: createSafeId<"workObligationEvent">(),
      workspaceId,
      obligationEntityId: entityId,
      actorUserId,
      type: WORK_OBLIGATION_EVENT_TYPE.CANCELLED,
      details: {
        type: "status_changed",
        previousStatus: assignedStatus,
        nextStatus: status,
      },
      occurredAt: now,
    });
  }
  await tx.insert(workObligationEvents).values(events);
};
