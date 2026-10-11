import { Result } from "better-result";

import { taskRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LIST_TASK_FEATURE_ACCESS } from "@/api/lib/tasks/legal-list-access";
import {
  updateTaskBodySchema,
  updateTaskHandler,
} from "@/api/lib/tasks/update-task";
import { enforceWritePrecondition } from "@/api/lib/write-contract";

const updateTask = createSafeHandler(
  {
    contract: "replace",
    precondition: { type: "updatedAt", field: "expectedUpdatedAt" },
    description:
      "Change one task in a matter: name, status, priority, due date, list " +
      "item type, sort order, or the calendar fields of an agenda item " +
      "(kind, start, end, occurrence, reminder, all-day, time zone, " +
      "location, meeting URL, availability, sensitivity, organizer, " +
      "attendees, recurrence). Only the fields you pass are written and a " +
      "read-only task is refused. Where governed work is enabled a status " +
      "change also records a lifecycle event, and workflowReason carries the " +
      "explanation stored with it.",
    featureAccess: LEGAL_LIST_TASK_FEATURE_ACCESS,
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    realtime: taskRealtimeUpdates,
    mcp: { type: "covered", by: "save_task" },
    body: updateTaskBodySchema,
  },
  async function* ({ workspaceId, user, body, safeDb, recordAuditEvent }) {
    const current = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: body.taskId },
            workspaceId: { eq: workspaceId },
            kind: { eq: "task" },
          },
          columns: { updatedAt: true },
        }),
      ),
    );
    if (!current?.updatedAt) {
      return Result.err(
        new HandlerError({ status: 404, message: "Task not found" }),
      );
    }
    const conflict = enforceWritePrecondition({
      type: "updatedAt",
      field: "expectedUpdatedAt",
      storedUpdatedAt: current.updatedAt,
      expectedUpdatedAt: body.expectedUpdatedAt,
      resource: "Task",
    });
    if (conflict !== null) {
      return Result.err(conflict);
    }

    return yield* updateTaskHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default updateTask;
