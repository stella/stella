import { Result } from "better-result";
import { t } from "elysia";

import { taskAssignees } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { TASK_ASSIGNEE_ROLES } from "@/api/lib/entity-constants";
import type { TaskAssigneeRole } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

const addAssigneeBodySchema = t.Object({
  taskId: tUuid,
  userId: t.String({ minLength: 1 }),
  role: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
});

const isTaskAssigneeRole = (value: string): value is TaskAssigneeRole =>
  includes(TASK_ASSIGNEE_ROLES, value);

const addAssignee = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    body: addAssigneeBodySchema,
  },
  async function* ({ workspaceId, body, safeDb }) {
    const role = body.role ?? "assignee";
    if (!isTaskAssigneeRole(role)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid assignee role" }),
      );
    }

    const [task, isMember] = yield* Result.await(
      safeDb(
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
      ),
    );

    if (!task) {
      return Result.err(
        new HandlerError({ status: 404, message: "Task not found" }),
      );
    }
    if (!isMember) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "User is not a member of this workspace",
        }),
      );
    }

    yield* Result.await(
      safeDb((tx) =>
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
      ),
    );

    return Result.ok({ success: true });
  },
);

export default addAssignee;
