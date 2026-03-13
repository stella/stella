import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { taskAssignees } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { TASK_ASSIGNEE_ROLES } from "@/api/lib/entity-constants";
import type { TaskAssigneeRole } from "@/api/lib/entity-constants";

export const addAssigneeBodySchema = t.Object({
  taskId: tNanoid,
  userId: t.String({ minLength: 1 }),
  role: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
});

type AddAssigneeBody = Static<typeof addAssigneeBodySchema>;

export const removeAssigneeBodySchema = t.Object({
  taskId: tNanoid,
  userId: t.String({ minLength: 1 }),
});

type RemoveAssigneeBody = Static<typeof removeAssigneeBodySchema>;

type AssigneeProps<T> = {
  workspaceId: SafeId<"workspace">;
  body: T;
  scopedDb: ScopedDb;
};

const isTaskAssigneeRole = (value: string): value is TaskAssigneeRole =>
  (TASK_ASSIGNEE_ROLES as readonly string[]).includes(value);

export const addAssigneeHandler = async ({
  workspaceId,
  body,
  scopedDb,
}: AssigneeProps<AddAssigneeBody>) => {
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
};

export const removeAssigneeHandler = async ({
  workspaceId,
  body,
  scopedDb,
}: AssigneeProps<RemoveAssigneeBody>) => {
  const task = await scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: body.taskId,
        workspaceId: { eq: workspaceId },
        kind: "task",
      },
      columns: { id: true },
    }),
  );
  if (!task) {
    return status(404, { message: "Task not found" });
  }

  await scopedDb((tx) =>
    tx
      .delete(taskAssignees)
      .where(
        and(
          eq(taskAssignees.entityId, body.taskId),
          eq(taskAssignees.userId, body.userId),
          eq(taskAssignees.workspaceId, workspaceId),
        ),
      ),
  );

  return { success: true };
};
