import { getFlowRunHandler } from "@/api/handlers/flows/run-read";
import { flowRunParamsSchema } from "@/api/handlers/flows/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";

const config = {
  featureAccess: { featureId: "flows", type: "required" },
  description:
    "Read one flow run, including its current status, inputs, outputs, steps, and review state.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  access: "read",
  params: flowRunParamsSchema,
} satisfies WorkspaceHandlerConfig;

const getFlowRun = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    return yield* getFlowRunHandler({
      safeDb,
      workspaceId,
      runId: params.runId,
    });
  },
);

export default getFlowRun;
