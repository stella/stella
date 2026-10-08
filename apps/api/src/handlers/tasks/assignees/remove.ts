import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import { resultTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { taskRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FLOW_TASK_FEATURE_ACCESS } from "@/api/lib/flows/review-gate-task";
import { admitTaskFlowMutation } from "@/api/lib/flows/review-task-admission";
import { removeTaskAssignment } from "@/api/lib/tasks/assignment-membership";

const removeAssigneeBodySchema = t.Object({
  taskId: tSafeId("entity"),
  userId: tUserId,
});

export type RemoveAssigneeHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof removeAssigneeBodySchema>;
};

// Shared task-assignee remove logic reused by the HTTP handler and the
// `save_task` MCP tool, so both emit identical audit events.
export const removeAssigneeHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
}: RemoveAssigneeHandlerProps) {
  yield* Result.await(
    resultTx(safeDb, async (tx) => {
      const admission = await admitTaskFlowMutation(tx, {
        workspaceId,
        userId,
        target: { type: "entities", entityIds: [body.taskId] },
      });
      if (admission.isErr()) {
        return admission;
      }
      const task = await tx.query.entities.findFirst({
        where: {
          id: { eq: body.taskId },
          kind: { eq: "task" },
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true, readOnly: true },
      });
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
      return Result.ok(undefined);
    }),
  );

  return Result.ok({ success: true });
};

const removeAssignee = createSafeHandler(
  {
    description:
      "Unassign one user from a task. Idempotent: removing a user who is not " +
      "assigned still succeeds, and nothing stops a task from ending up with " +
      "no assignee; a read-only task is refused.",
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: FLOW_TASK_FEATURE_ACCESS,
    realtime: taskRealtimeUpdates,
    mcp: { type: "covered", by: "save_task" },
    body: removeAssigneeBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent, user }) {
    return yield* removeAssigneeHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default removeAssignee;
