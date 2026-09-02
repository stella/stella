import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, taskAssignees } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { TASK_ASSIGNEE_ROLE } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const moveAssigneeBodySchema = t.Object({
  taskId: tSafeId("entity"),
  fromUserId: t.Nullable(tUserId),
  toUserId: t.Nullable(tUserId),
});

export type MoveAssigneeHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof moveAssigneeBodySchema>;
};

type MoveAssigneeTxResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; message: string };

// Shared task-assignee move logic: removes `fromUserId` and adds `toUserId`
// (whichever are non-null) in a single transaction, so a kanban lane drag
// never leaves a task with neither assignee when the add half would have
// failed on its own. Guards mirror tasks.assignees-add and
// tasks.assignees-remove: the task must exist, must not be read-only, and a
// new `toUserId` must be a member of the workspace — all re-checked INSIDE
// the same transaction that locks the task row (`for("update")`) and does
// the writes, so a concurrent read-only transition or member removal
// between a separate validation transaction and the write can never slip
// through (see handlers/entities/rename.ts and handlers/properties/update.ts
// for the same lock-then-guard-in-tx shape). Idempotent in both directions,
// exactly like the handlers it replaces for this call site.
export const moveAssigneeHandler = async function* ({
  safeDb,
  workspaceId,
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

  const txResult = yield* Result.await(
    safeDb(async (tx): Promise<MoveAssigneeTxResult> => {
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
        return { ok: false, status: 404, message: "Task not found" };
      }
      if (task.readOnly) {
        return { ok: false, status: 409, message: "Task is read-only" };
      }

      if (toUserId !== null) {
        const member = await tx.query.workspaceMembers.findFirst({
          where: {
            workspaceId: { eq: workspaceId },
            userId: toUserId,
          },
          columns: { id: true },
        });
        if (!member) {
          return {
            ok: false,
            status: 400,
            message: "User is not a member of this workspace",
          };
        }
      }

      if (fromUserId !== null) {
        await tx
          .delete(taskAssignees)
          .where(
            and(
              eq(taskAssignees.entityId, taskId),
              eq(taskAssignees.userId, fromUserId),
              eq(taskAssignees.workspaceId, workspaceId),
            ),
          );
      }

      if (toUserId !== null) {
        await tx
          .insert(taskAssignees)
          .values({
            entityId: taskId,
            workspaceId,
            userId: toUserId,
            role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
          })
          .onConflictDoUpdate({
            target: [taskAssignees.entityId, taskAssignees.userId],
            set: { role: TASK_ASSIGNEE_ROLE.ASSIGNEE },
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

      return { ok: true };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

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
    mcp: { type: "covered", by: "save_task" },
    body: moveAssigneeBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent }) {
    return yield* moveAssigneeHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default moveAssignee;
