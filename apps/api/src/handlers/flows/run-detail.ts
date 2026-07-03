import { getFlowRunHandler } from "@/api/handlers/flows/run-read";
import { flowRunParamsSchema } from "@/api/handlers/flows/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "pending" },
  params: flowRunParamsSchema,
} satisfies HandlerConfig;

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
