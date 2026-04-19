import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { taskAssignees } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const removeAssigneeBodySchema = t.Object({
  taskId: tNanoid,
  userId: t.String({ minLength: 1 }),
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
            id: body.taskId,
            workspaceId: { eq: workspaceId },
            kind: "task",
          },
          columns: { id: true },
        }),
      ),
    );
    if (!task) {
      return Result.err(
        new HandlerError({ status: 404, message: "Task not found" }),
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
