import { and, eq, inArray, sql } from "drizzle-orm";
import { rootDb } from "@/api/db/root";
import { entities, taskAssignees } from "@/api/db/schema";
import { createNotification } from "@/api/lib/notifications";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

export const CHECK_DEADLINES_TASK = "scheduler.checkDeadlines";

export const checkDeadlines: SchedulerTask = async ({ logger }) => {
  logger.info("scheduler.checkDeadlines starting");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowString = tomorrow.toISOString().split("T")[0]; // YYYY-MM-DD

  const entitiesDue = await rootDb
    .select({
      id: entities.id,
      name: entities.name,
      dueDate: entities.dueDate,
      createdBy: entities.createdBy,
    })
    .from(entities)
    .where(
      and(
        eq(entities.kind, "task"),
        sql`${entities.dueDate} = ${tomorrowString}`
      )
    );

  if (entitiesDue.length === 0) {
    logger.info("scheduler.checkDeadlines: no tasks due tomorrow");
    return;
  }

  logger.info(`Found ${entitiesDue.length} tasks due tomorrow`);

  // Batch-fetch all assignees in one query instead of one per task.
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
      await rootDb.transaction(async (tx) => {
        await createNotification(tx, {
          userId: brandPersistedUserId(userId),
          title: "Task Deadline Approaching",
          message: `The task "${task.name}" is due tomorrow (${task.dueDate}).`,
          entityType: "entity",
          entityId: task.id,
        });
      });
    }
  }

  logger.info("scheduler.checkDeadlines completed");
};
