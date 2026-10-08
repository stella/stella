import { taskRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { FLOW_TASK_FEATURE_ACCESS } from "@/api/lib/flows/review-gate-task";
import {
  updateTaskBodySchema,
  updateTaskHandler,
} from "@/api/lib/tasks/update-task";

const updateTask = createSafeHandler(
  {
    description:
      "Change one task in a matter: name, status, priority, due date, list " +
      "item type, sort order, or the calendar fields of an agenda item " +
      "(kind, start, end, occurrence, reminder, all-day, time zone, " +
      "location, meeting URL, availability, sensitivity, organizer, " +
      "attendees, recurrence). Only the fields you pass are written and a " +
      "read-only task is refused. Where governed work is enabled a status " +
      "change also records a lifecycle event, and workflowReason carries the " +
      "explanation stored with it.",
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: FLOW_TASK_FEATURE_ACCESS,
    realtime: taskRealtimeUpdates,
    mcp: { type: "covered", by: "save_task" },
    body: updateTaskBodySchema,
  },
  async function* ({ workspaceId, user, body, safeDb, recordAuditEvent }) {
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
