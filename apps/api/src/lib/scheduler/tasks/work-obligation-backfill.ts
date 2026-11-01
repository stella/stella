import { panic } from "better-result";
import { and, eq, gt, inArray } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { isUuid } from "@stll/uuid-codec";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  schedulerJobs,
  taskAssignees,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateEntityBatch,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  brandPersistedEntityId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { lockTaskAssignmentMembers } from "@/api/lib/tasks/assignment-membership";
import { isWorkObligationEligible } from "@/api/lib/work-obligations/eligibility";
import {
  legacyWorkObligationCreatedEvents,
  legacyWorkObligationValues,
} from "@/api/lib/work-obligations/legacy-work-obligation";

export const BACKFILL_WORK_OBLIGATIONS_TASK =
  "workObligations.backfillLegacyTasks" as const;

const BACKFILL_LIMIT = 1000;

type CandidateTaskIdentity = {
  id: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

const readCandidateTaskAssignments = async ({
  tx,
  tasks,
}: {
  tx: Transaction;
  tasks: readonly CandidateTaskIdentity[];
}) =>
  await tx
    .select({
      entityId: taskAssignees.entityId,
      userId: taskAssignees.userId,
      workspaceId: taskAssignees.workspaceId,
    })
    .from(taskAssignees)
    .where(
      and(
        inArray(
          taskAssignees.entityId,
          tasks.map(({ id }) => id),
        ),
        inArray(
          taskAssignees.workspaceId,
          tasks.map((task) => task.workspaceId),
        ),
      ),
    );

type CandidateTaskAssignment = Awaited<
  ReturnType<typeof readCandidateTaskAssignments>
>[number];

/**
 * Member locks rank before the task's entity lock, so they are taken for the
 * assignees read beforehand. Each workspace's members are locked in sorted
 * order; the result names who was locked and who is still a live member.
 */
const lockCandidateTaskAssignees = async ({
  tx,
  assignments,
}: {
  tx: Transaction;
  assignments: readonly CandidateTaskAssignment[];
}) => {
  const userIdsByWorkspace = new Map<SafeId<"workspace">, string[]>();
  for (const assignment of assignments) {
    const userIds = userIdsByWorkspace.get(assignment.workspaceId);
    if (userIds === undefined) {
      userIdsByWorkspace.set(assignment.workspaceId, [assignment.userId]);
      continue;
    }
    userIds.push(assignment.userId);
  }
  const liveUsersByWorkspace = new Map<
    SafeId<"workspace">,
    ReadonlySet<string>
  >();
  for (const [workspaceId, userIds] of [...userIdsByWorkspace].toSorted(
    ([left], [right]) => compareCodeUnit(left, right),
  )) {
    liveUsersByWorkspace.set(
      workspaceId,
      // db-await-in-loop: member locks are taken one workspace at a time in sorted order, bounded by the page's workspaces.
      await lockTaskAssignmentMembers({ tx, workspaceId, userIds }),
    );
  }
  return {
    locked: (assignment: CandidateTaskAssignment) =>
      userIdsByWorkspace
        .get(assignment.workspaceId)
        ?.includes(assignment.userId) === true,
    live: (assignment: CandidateTaskAssignment) =>
      liveUsersByWorkspace
        .get(assignment.workspaceId)
        ?.has(assignment.userId) === true,
  };
};

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
  db,
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
  const outcome = await withAggregateTransaction(db, async (tx) => {
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

    const candidateTasks = entityPage.filter(
      ({ kind, listItemType, obligationEntityId }) =>
        kind === "task" &&
        obligationEntityId === null &&
        isWorkObligationEligible(listItemType),
    );
    await lockWorkspacesForEntityCap(
      tx,
      candidateTasks.map((task) => brandPersistedWorkspaceId(task.workspaceId)),
    );

    let insertedCount = 0;
    if (candidateTasks.length > 0) {
      const candidates = candidateTasks.map((task) => ({
        id: task.id,
        workspaceId: brandPersistedWorkspaceId(task.workspaceId),
      }));
      const members = await lockCandidateTaskAssignees({
        tx,
        assignments: await readCandidateTaskAssignments({
          tx,
          tasks: candidates,
        }),
      });
      await withAggregateEntityBatch({
        tx,
        ids: candidates,
        mode: "update",
        limit: BACKFILL_LIMIT,
      });
      // Assignment writers hold the entity lock, so this read is current. An
      // assignee added before it needs a member lock that can no longer be
      // taken in order; the page is retried on the next run instead.
      const currentAssignments = await readCandidateTaskAssignments({
        tx,
        tasks: candidates,
      });
      if (!currentAssignments.every(members.locked)) {
        return {
          status: "assignments_changed" as const,
          inserted: 0,
          scanned: 0,
        };
      }
      const assignments = currentAssignments.filter(members.live);
      const currentTasks = await tx
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
        .where(
          inArray(
            entities.id,
            candidateTasks.map(({ id }) => id),
          ),
        );
      const tasks = currentTasks.filter(
        ({ kind, listItemType, obligationEntityId }) =>
          kind === "task" &&
          obligationEntityId === null &&
          isWorkObligationEligible(listItemType),
      );
      if (tasks.length > 0) {
        const taskIds = new Set(tasks.map(({ id }) => id));
        const assigneesByEntity = new Map<SafeId<"entity">, SafeId<"user">[]>();
        for (const assignment of assignments) {
          if (!taskIds.has(assignment.entityId)) {
            continue;
          }
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
