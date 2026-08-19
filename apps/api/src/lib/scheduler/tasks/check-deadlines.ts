import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { rootDb } from "@/api/db/root";
import { entities, taskAssignees, workspaces } from "@/api/db/schema";
import { createNotification } from "@/api/lib/notifications";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { SafeId } from "@/api/lib/branded-types";

export const CHECK_DEADLINES_TASK = "scheduler.checkDeadlines";

export const checkDeadlines: SchedulerTask = async ({ logger }) => {
  logger.info("scheduler.checkDeadlines starting");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowString = tomorrow.toISOString().split("T")[0]; // YYYY-MM-DD

  let nextWorkspaceCursor: SafeId<"workspace"> | undefined = undefined;
  const batchSize = 50;
  let hasMoreWorkspaces = true;

  while (hasMoreWorkspaces) {
    const workspacesBatch = await rootDb
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(nextWorkspaceCursor ? gt(workspaces.id, nextWorkspaceCursor) : undefined)
      .orderBy(workspaces.id)
      .limit(batchSize);

    if (workspacesBatch.length === 0) {
      break;
    }

    const workspaceIds = workspacesBatch.map((w) => w.id);
    nextWorkspaceCursor = workspacesBatch.at(-1)?.id;
    if (workspacesBatch.length < batchSize) {
      hasMoreWorkspaces = false;
    }

    // Query tasks due tomorrow matching (workspaceId, dueDate) index
    const entitiesDue = await rootDb
      .select({
        id: entities.id,
        name: entities.name,
        dueDate: entities.dueDate,
        createdBy: entities.createdBy,
        workspaceId: entities.workspaceId,
      })
      .from(entities)
      .where(
        and(
          eq(entities.kind, "task"),
          inArray(entities.workspaceId, workspaceIds),
          sql`${entities.dueDate} = ${tomorrowString}`
        )
      );

    if (entitiesDue.length === 0) {
      continue;
    }

    logger.info(`Processing ${entitiesDue.length} tasks due tomorrow in workspaces batch`);

    // Batch-fetch all assignees for due tasks
    const entityIds = entitiesDue.map((e) => e.id);
    const allAssignees = await rootDb
      .select({ entityId: taskAssignees.entityId, userId: taskAssignees.userId })
      .from(taskAssignees)
      .where(inArray(taskAssignees.entityId, entityIds));

    // Build a map: entityId → Set<userId>
    const assigneeMap = new Map<string, Set<string>>();
    for (const { entityId, userId } of allAssignees) {
      let set = assigneeMap.get(entityId);
      if (!set) {
        set = new Set();
        assigneeMap.set(entityId, set);
      }
      set.add(userId);
    }

    for (const task of entitiesDue) {
      const userIdsToNotify = assigneeMap.get(task.id) ?? new Set<string>();
      // Fall back to creator when no assignees are found.
      if (userIdsToNotify.size === 0 && task.createdBy) {
        userIdsToNotify.add(task.createdBy);
      }

      for (const userId of userIdsToNotify) {
        // Deterministic idempotency key to prevent duplicate alerts
        const idempotencyKey = `deadline-reminder:${task.id}:${userId}:${task.dueDate}`;

        await rootDb.transaction(async (tx) => {
          await createNotification(tx, {
            userId: brandPersistedUserId(userId),
            title: "Task Deadline Approaching",
            message: `The task "${task.name}" is due tomorrow (${task.dueDate}).`,
            entityType: "entity",
            entityId: task.id,
            idempotencyKey,
          });
        });
      }
    }
  }

  logger.info("scheduler.checkDeadlines completed");
};
