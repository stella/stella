import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { taskAssignees } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

export const removeAssigneeBodySchema = t.Object({
  taskId: tNanoid,
  userId: t.String({ minLength: 1 }),
});

const removeAssignee = createHandler(
  {
    permissions: { entity: ["update"] },
    body: removeAssigneeBodySchema,
  },
  async ({ workspaceId, body, scopedDb }) => {
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
  },
);

export default removeAssignee;
