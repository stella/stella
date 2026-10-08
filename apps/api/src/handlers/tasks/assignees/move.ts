import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { resultTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import { taskRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { TASK_ASSIGNEE_ROLE } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FLOW_TASK_FEATURE_ACCESS } from "@/api/lib/flows/review-gate-task";
import { admitTaskFlowMutation } from "@/api/lib/flows/review-task-admission";
import {
  lockTaskAssignmentMembers,
  writeTaskAssignments,
  removeTaskAssignment,
} from "@/api/lib/tasks/assignment-membership";

const moveAssigneeBodySchema = t.Object({
  taskId: tSafeId("entity"),
  fromUserId: t.Nullable(tUserId),
  toUserId: t.Nullable(tUserId),
});

export type MoveAssigneeHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof moveAssigneeBodySchema>;
};

// Lock workspace -> membership -> task for both halves of a move. A failed
// destination validation preserves the previous assignments and their audit.
export const moveAssigneeHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
}: MoveAssigneeHandlerProps) {
  const { taskId, fromUserId, toUserId } = body;

  if (fromUserId === null && toUserId === null) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "At least one of fromUserId or toUserId is required",
      }),
    );
  }

  yield* Result.await(
    resultTx(safeDb, async (tx) => {
      const admission = await admitTaskFlowMutation(tx, {
        workspaceId,
        userId,
        target: { type: "entities", entityIds: [taskId] },
      });
      if (admission.isErr()) {
        return admission;
      }

      const members = await lockTaskAssignmentMembers({
        tx,
        workspaceId,
        userIds: toUserId === null ? [] : [toUserId],
      });
      const taskRows = await tx
        .select({ id: entities.id, readOnly: entities.readOnly })
        .from(entities)
        .where(
          and(
            eq(entities.id, taskId),
            eq(entities.kind, "task"),
            eq(entities.workspaceId, workspaceId),
          ),
        )
        .for("update");
      const task = taskRows.at(0);

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

      if (toUserId !== null && !members.has(toUserId)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "User is not a member of this workspace",
          }),
        );
      }

      if (fromUserId !== null) {
        await removeTaskAssignment({
          tx,
          workspaceId,
          entityId: taskId,
          userId: fromUserId,
        });
      }

      if (toUserId !== null) {
        await writeTaskAssignments({
          tx,
          workspaceId,
          assignments: [
            {
              entityId: taskId,
              userId: toUserId,
              role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
            },
          ],
        });
      }

      const events: AuditEvent[] = [];
      if (fromUserId !== null) {
        events.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: taskId,
          metadata: {
            kind: "task",
            change: "assignee-removed",
            assigneeUserId: fromUserId,
          },
        });
      }
      if (toUserId !== null) {
        events.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: taskId,
          metadata: {
            kind: "task",
            change: "assignee-added",
            assigneeUserId: toUserId,
            role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
          },
        });
      }
      await recordAuditEvent(tx, events);

      return Result.ok(undefined);
    }),
  );

  return Result.ok({ success: true });
};

const moveAssignee = createSafeHandler(
  {
    description:
      "Reassign a task from one member to another in one atomic step: " +
      "removes fromUserId (when not null) and adds toUserId (when not null) " +
      "together, so a failed add can never leave the task with neither " +
      "assignee. At least one of the two must be non-null. Refused when a " +
      "new toUserId is not a member of this matter and when the task is " +
      "read-only.",
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: FLOW_TASK_FEATURE_ACCESS,
    realtime: taskRealtimeUpdates,
    mcp: { type: "covered", by: "save_task" },
    body: moveAssigneeBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent, user }) {
    return yield* moveAssigneeHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default moveAssignee;
