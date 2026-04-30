import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { taskAssignees } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const removeAssigneeBodySchema = t.Object({
  taskId: tSafeId("entity"),
  userId: tUserId,
});

const removeAssignee = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    body: removeAssigneeBodySchema,
  },
  async function* ({ workspaceId, body, safeDb }) {
    const task = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: body.taskId },
            kind: { eq: "task" },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true, readOnly: true },
        }),
      ),
    );
    if (!task) {
      return Result.err(
        new HandlerError({ status: 404, message: "Task not found" }),
      );
    }
    if (task.readOnly) {
      return Result.err(
        new HandlerError({ status: 409, message: "Task is read-only" }),
      );
    }

    yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(taskAssignees)
          .where(
            and(
              eq(taskAssignees.entityId, body.taskId),
              eq(taskAssignees.userId, body.userId),
              eq(taskAssignees.workspaceId, workspaceId),
            ),
          ),
      ),
    );

    return Result.ok({ success: true });
  },
);

export default removeAssignee;
