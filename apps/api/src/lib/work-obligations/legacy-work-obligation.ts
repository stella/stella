import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
  workObligations,
} from "@/api/db/schema";
import type {
  WorkObligationSource,
  WorkObligationStatus,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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
};

export const legacyWorkObligationValues = (task: LegacyTask) => {
  let status: WorkObligationStatus = WORK_OBLIGATION_STATUS.UNASSIGNED;
  if (task.status === "done") {
    status = WORK_OBLIGATION_STATUS.COMPLETED;
  } else if (task.status === "cancelled") {
    status = WORK_OBLIGATION_STATUS.CANCELLED;
  }

  let sourceType: WorkObligationSource = WORK_OBLIGATION_SOURCE.MANUAL;
  if (
    task.agendaSource === WORK_OBLIGATION_SOURCE.CALENDAR ||
    task.agendaSource === WORK_OBLIGATION_SOURCE.EMAIL ||
    task.agendaSource === WORK_OBLIGATION_SOURCE.IMPORT ||
    task.agendaSource === WORK_OBLIGATION_SOURCE.API
  ) {
    sourceType = task.agendaSource;
  }

  const isDeadline = task.agendaKind === WORK_OBLIGATION_TYPE.DEADLINE;
  return {
    entityId: task.id,
    workspaceId: task.workspaceId,
    type: isDeadline
      ? WORK_OBLIGATION_TYPE.DEADLINE
      : WORK_OBLIGATION_TYPE.TASK,
    status,
    workingTargetDate: task.dueDate,
    hardDeadlineDate: isDeadline ? task.dueDate : null,
    sourceType,
    createdByUserId: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt ?? task.createdAt,
  };
};

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
  const tasks = await tx
    .select({
      id: entities.id,
      workspaceId: entities.workspaceId,
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
  if (!task) {
    return;
  }

  await tx
    .insert(workObligations)
    .values(legacyWorkObligationValues(task))
    .onConflictDoNothing({ target: workObligations.entityId });
};
