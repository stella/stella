import { taskCreateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import {
  createTaskBodySchema,
  createTaskEntityHandler,
} from "@/api/lib/tasks/create-task-entity";
import {
  deployedTaskFeatures,
  type TaskDeploymentFeatures,
} from "@/api/lib/tasks/deployment-features";
import { LEGAL_LIST_TASK_FEATURE_ACCESS } from "@/api/lib/tasks/legal-list-access";

export const createTaskForFeatures = (features: TaskDeploymentFeatures) =>
  createSafeHandler(
    {
      description:
        "Create a task in the current matter: name plus optional parent, " +
        "status, priority, due date, assignees, calendar fields for an " +
        "agenda item (kind, start, end, occurrence, reminder, all-day, time " +
        "zone, location, meeting URL, attendees, recurrence), list " +
        "placement, and, where the deployment enables governed work, its " +
        "owner and target and deadline dates. Change one afterwards with " +
        "tasks.update.",
      featureAccess: LEGAL_LIST_TASK_FEATURE_ACCESS,
      permissions: { entity: ["create"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      realtime: taskCreateRealtimeUpdates,
      mcp: { type: "tool", name: "save_task" },
      body: createTaskBodySchema,
    },
    async function* ({ workspaceId, user, body, safeDb, recordAuditEvent }) {
      return yield* createTaskEntityHandler({
        safeDb,
        workspaceId,
        userId: user.id,
        recordAuditEvent,
        body,
        features,
      });
    },
  );

const createTask = createTaskForFeatures(deployedTaskFeatures());

export const createTaskHandler = createTask.handler;

export default createTask;
