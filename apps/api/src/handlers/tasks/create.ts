import { eq } from "drizzle-orm";
import { status, t } from "elysia";

import {
  entities,
  entityVersions,
  taskAssignees,
  workspaces,
} from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { ENTITY_PRIORITIES, TASK_STATUSES } from "@/api/lib/entity-constants";
import { LIMITS } from "@/api/lib/limits";

export const createTaskBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  parentId: t.Optional(tNanoid),
  status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  priority: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  assigneeIds: t.Optional(
    t.Array(t.String(), {
      maxItems: LIMITS.workspaceMembersCount,
    }),
  ),
});

const createTask = createHandler(
  {
    permissions: { entity: ["create"] },
    body: createTaskBodySchema,
  },
  async ({ workspaceId, user, body, scopedDb }) => {
    const taskStatus = body.status ?? "open";
    const taskPriority = body.priority ?? "none";

    if (!(TASK_STATUSES as readonly string[]).includes(taskStatus)) {
      return status(400, { message: "Invalid task status" });
    }
    if (!(ENTITY_PRIORITIES as readonly string[]).includes(taskPriority)) {
      return status(400, { message: "Invalid task priority" });
    }

    return await scopedDb(async (tx) => {
      const totalEntities = await tx.$count(
        entities,
        eq(entities.workspaceId, workspaceId),
      );
      if (totalEntities >= LIMITS.entitiesCount) {
        return status(400, { message: "Entities limit reached" });
      }

      if (body.parentId) {
        const parent = await tx.query.entities.findFirst({
          where: {
            id: body.parentId,
            workspaceId: { eq: workspaceId },
          },
          columns: { kind: true },
        });
        if (!parent) {
          return status(400, {
            message: "Parent entity not found in this workspace",
          });
        }
        if (parent.kind !== "task") {
          return status(400, {
            message: `Subtasks must belong to a task, not a ${parent.kind}`,
          });
        }
      }

      const entityId = crypto.randomUUID();
      await tx.insert(entities).values({
        id: entityId,
        workspaceId,
        kind: "task",
        parentId: body.parentId ?? null,
        name: body.name,
        createdBy: user.id,
        status: taskStatus,
        priority: taskPriority,
        dueDate: body.dueDate ?? null,
      });

      const entityVersionId = crypto.randomUUID();
      await tx.insert(entityVersions).values({
        id: entityVersionId,
        workspaceId,
        entityId,
        versionNumber: 1,
      });

      await tx
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      if (body.assigneeIds !== undefined && body.assigneeIds.length > 0) {
        const members = await tx.query.workspaceMembers.findMany({
          where: {
            workspaceId: { eq: workspaceId },
            userId: { in: body.assigneeIds },
          },
          columns: { userId: true },
        });
        const memberIds = new Set(members.map((m) => m.userId));
        const invalidIds = body.assigneeIds.filter(
          (uid) => !memberIds.has(uid),
        );
        if (invalidIds.length > 0) {
          return status(400, {
            message: "Some assignee IDs are not workspace members",
          });
        }
        const validIds = [...new Set(body.assigneeIds)];

        if (validIds.length > 0) {
          await tx.insert(taskAssignees).values(
            validIds.map((uid) => ({
              entityId,
              workspaceId,
              userId: uid,
              role: "assignee" as const,
            })),
          );
        }
      }

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      return { entityId };
    });
  },
);

export const createTaskHandler = createTask.handler;

export default createTask;
