import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { entities } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { ENTITY_PRIORITIES, TASK_STATUSES } from "@/api/lib/entity-constants";
import { includes } from "@/api/lib/type-guards";

export const updateTaskBodySchema = t.Object({
  taskId: tNanoid,
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  priority: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  sortOrder: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
});

const updateTask = createHandler(
  {
    permissions: { entity: ["update"] },
    body: updateTaskBodySchema,
  },
  async ({ workspaceId, body, scopedDb }) => {
    if (body.status !== undefined && !includes(TASK_STATUSES, body.status)) {
      return status(400, { message: "Invalid task status" });
    }
    if (
      body.priority !== undefined &&
      !includes(ENTITY_PRIORITIES, body.priority)
    ) {
      return status(400, { message: "Invalid task priority" });
    }

    const updated = await scopedDb((tx) =>
      tx
        .update(entities)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.status !== undefined && {
            status: body.status,
          }),
          ...(body.priority !== undefined && {
            priority: body.priority,
          }),
          ...(body.dueDate !== undefined && {
            dueDate: body.dueDate,
          }),
          ...(body.sortOrder !== undefined && {
            sortOrder: body.sortOrder,
          }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(entities.id, body.taskId),
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "task"),
          ),
        )
        .returning({ id: entities.id }),
    );

    if (updated.length === 0) {
      return status(404, { message: "Task not found" });
    }

    return { success: true };
  },
);

export default updateTask;
