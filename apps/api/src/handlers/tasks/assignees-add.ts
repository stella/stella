import { status, t } from "elysia";

import { taskAssignees } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { TASK_ASSIGNEE_ROLES } from "@/api/lib/entity-constants";
import type { TaskAssigneeRole } from "@/api/lib/entity-constants";

export const addAssigneeBodySchema = t.Object({
  taskId: tNanoid,
  userId: t.String({ minLength: 1 }),
  role: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
});

const isTaskAssigneeRole = (value: string): value is TaskAssigneeRole =>
  (TASK_ASSIGNEE_ROLES as readonly string[]).includes(value);

const addAssignee = createHandler(
  {
    permissions: { entity: ["update"] },
    body: addAssigneeBodySchema,
  },
  async ({ workspaceId, body, scopedDb }) => {
    const role = body.role ?? "assignee";
    if (!isTaskAssigneeRole(role)) {
      return status(400, { message: "Invalid assignee role" });
    }

    const [task, isMember] = await scopedDb(
      async (tx) =>
        await Promise.all([
          tx.query.entities.findFirst({
            where: {
              id: body.taskId,
              workspaceId: { eq: workspaceId },
              kind: "task",
            },
            columns: { id: true },
          }),
          tx.query.workspaceMembers.findFirst({
            where: {
              workspaceId: { eq: workspaceId },
              userId: body.userId,
            },
            columns: { id: true },
          }),
        ]),
    );

    if (!task) {
      return status(404, { message: "Task not found" });
    }
    if (!isMember) {
      return status(400, {
        message: "User is not a member of this workspace",
      });
    }

    await scopedDb((tx) =>
      tx
        .insert(taskAssignees)
        .values({
          entityId: body.taskId,
          workspaceId,
          userId: body.userId,
          role,
        })
        .onConflictDoUpdate({
          target: [taskAssignees.entityId, taskAssignees.userId],
          set: { role },
        }),
    );

    return { success: true };
  },
);

export default addAssignee;
