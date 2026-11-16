import { Result } from "better-result";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { taskRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema, userIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { removeTaskAssignment } from "@/api/lib/tasks/assignment-membership";

const removeAssigneeBodySchema = v.object({
  taskId: resourceIdSchema("entity"),
  userId: userIdSchema,
});

export type RemoveAssigneeHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: v.InferOutput<typeof removeAssigneeBodySchema>;
};

// Shared task-assignee remove logic reused by the HTTP handler and the
// `save_task` MCP tool, so both emit identical audit events.
export const removeAssigneeHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
  body,
}: RemoveAssigneeHandlerProps) {
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
      await removeTaskAssignment({
        tx,
        workspaceId,
        entityId: body.taskId,
        userId: body.userId,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: body.taskId,
        metadata: {
          kind: "task",
          change: "assignee-removed",
          assigneeUserId: body.userId,
        },
      });
    }),
  );

  return Result.ok({ success: true });
};

const removeAssignee = createSafeHandler(
  {
    contract: "patch",
    description:
      "Unassign one user from a task. Idempotent: removing a user who is not " +
      "assigned still succeeds, and nothing stops a task from ending up with " +
      "no assignee; a read-only task is refused.",
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    realtime: taskRealtimeUpdates,
    mcp: { type: "covered", by: "save_task" },
    body: removeAssigneeBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent }) {
    return yield* removeAssigneeHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default removeAssignee;
