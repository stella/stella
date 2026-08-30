import { panic } from "better-result";
import { and, eq, gt, inArray } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  entities,
  schedulerJobs,
  taskAssignees,
  workObligationEvents,
  workObligations,
  workspaceMembers,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  brandPersistedEntityId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { isWorkObligationEligible } from "@/api/lib/work-obligations/eligibility";
import {
  legacyWorkObligationCreatedEvents,
  legacyWorkObligationValues,
} from "@/api/lib/work-obligations/legacy-work-obligation";

export const BACKFILL_WORK_OBLIGATIONS_TASK =
  "workObligations.backfillLegacyTasks" as const;

const BACKFILL_LIMIT = 1000;

const backfillCursor = (
  payload: Record<string, unknown> | null,
): SafeId<"entity"> | null => {
  const cursor = payload?.["cursor"];
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (typeof cursor !== "string" || !isUuid(cursor)) {
    return panic("Work-obligation backfill cursor must be a UUID");
  }
  return brandPersistedEntityId(cursor);
};

/**
 * Scan one bounded entity page and repair its missing work rows. Resetting the
 * durable cursor after a full pass detects late legacy writes without a
 * steady-state full-table anti-join.
 */
export const backfillWorkObligations: SchedulerTask = async ({
  job,
  logger,
  signal,
}) => {
  if (!env.FEATURE_GOVERNED_WORKFLOW) {
    return;
  }

  signal.throwIfAborted();
  const cursor = backfillCursor(job.payload);
  const leaseToken =
    job.lockedBy ??
    panic("Work-obligation backfill requires a scheduler lease");
  const outcome = await rootDb.transaction(async (tx) => {
    const entityPage = await tx
      .select({
        id: entities.id,
        workspaceId: entities.workspaceId,
        kind: entities.kind,
        listItemType: entities.listItemType,
        agendaKind: entities.agendaKind,
        agendaSource: entities.agendaSource,
        status: entities.status,
        dueDate: entities.dueDate,
        createdBy: entities.createdBy,
        createdAt: entities.createdAt,
        updatedAt: entities.updatedAt,
        obligationEntityId: workObligations.entityId,
      })
      .from(entities)
      .leftJoin(
        workObligations,
        and(
          eq(workObligations.entityId, entities.id),
          eq(workObligations.workspaceId, entities.workspaceId),
        ),
      )
      .where(cursor === null ? undefined : gt(entities.id, cursor))
      .orderBy(entities.id)
      .limit(BACKFILL_LIMIT);

    signal.throwIfAborted();
    const lastEntity = entityPage.at(-1);
    if (!lastEntity) {
      await tx
        .update(schedulerJobs)
        .set({ payload: { cursor: null } })
        .where(
          and(
            eq(schedulerJobs.id, job.id),
            eq(schedulerJobs.lockedBy, leaseToken),
          ),
        );
      return { status: "cycle_complete" as const, inserted: 0, scanned: 0 };
    }

    const tasks = entityPage.filter(
      ({ kind, listItemType, obligationEntityId }) =>
        kind === "task" &&
        obligationEntityId === null &&
        isWorkObligationEligible(listItemType),
    );
    await lockWorkspacesForEntityCap(
      tx,
      tasks.map((task) => brandPersistedWorkspaceId(task.workspaceId)),
    );

    let insertedCount = 0;
    if (tasks.length > 0) {
      const assignments = await tx
        .select({
          entityId: taskAssignees.entityId,
          userId: taskAssignees.userId,
        })
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
            inArray(
              taskAssignees.entityId,
              tasks.map(({ id }) => id),
            ),
            inArray(
              taskAssignees.workspaceId,
              tasks.map((task) => brandPersistedWorkspaceId(task.workspaceId)),
            ),
          ),
        )
        .for("update", { of: workspaceMembers });
      const assigneesByEntity = new Map<SafeId<"entity">, SafeId<"user">[]>();
      for (const assignment of assignments) {
        const assignees = assigneesByEntity.get(assignment.entityId);
        if (assignees) {
          assignees.push(brandPersistedUserId(assignment.userId));
        } else {
          assigneesByEntity.set(assignment.entityId, [
            brandPersistedUserId(assignment.userId),
          ]);
        }
      }

      const inserted = await tx
        .insert(workObligations)
        .values(
          tasks.map((task) =>
            legacyWorkObligationValues({
              ...task,
              workspaceId: brandPersistedWorkspaceId(task.workspaceId),
              assigneeUserIds: arrayOrEmpty(assigneesByEntity.get(task.id)),
            }),
          ),
        )
        .onConflictDoNothing({ target: workObligations.entityId })
        .returning({
          entityId: workObligations.entityId,
          workspaceId: workObligations.workspaceId,
          createdByUserId: workObligations.createdByUserId,
        });
      insertedCount = inserted.length;
      if (inserted.length > 0) {
        await tx
          .insert(workObligationEvents)
          .values(legacyWorkObligationCreatedEvents(inserted, new Date()));
      }
    }

    await tx
      .update(schedulerJobs)
      .set({ payload: { cursor: lastEntity.id } })
      .where(
        and(
          eq(schedulerJobs.id, job.id),
          eq(schedulerJobs.lockedBy, leaseToken),
        ),
      );

    return {
      status: "progress" as const,
      inserted: insertedCount,
      scanned: entityPage.length,
    };
  });

  // audit: skip — bounded compatibility repair derived from existing tasks;
  // scheduler_job_runs provides the durable operator trail.
  logger.info("scheduler.work_obligations_backfilled", {
    "workObligations.inserted": outcome.inserted,
    "workObligations.scanned": outcome.scanned,
    "workObligations.status": outcome.status,
  });
};
