import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { taskAssignees } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
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
  async function* ({ workspaceId, body, safeDb, recordAuditEvent }) {
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
      safeDb(async (tx) => {
        await tx
          .delete(taskAssignees)
          .where(
            and(
              eq(taskAssignees.entityId, body.taskId),
              eq(taskAssignees.userId, body.userId),
              eq(taskAssignees.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: body.taskId,
          metadata: {
            change: "assignee-removed",
            assigneeUserId: body.userId,
          },
        });
      }),
    );

    return Result.ok({ success: true });
  },
);

export default removeAssignee;
