import { createSafeHandler } from "@/api/lib/api-handlers";
import {
  createTaskBodySchema,
  createTaskEntityHandler,
} from "@/api/lib/tasks/create-task-entity";
import {
  deployedTaskFeatures,
  type TaskDeploymentFeatures,
} from "@/api/lib/tasks/deployment-features";

export const createTaskForFeatures = (features: TaskDeploymentFeatures) =>
  createSafeHandler(
    {
      permissions: { entity: ["create"] },
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
