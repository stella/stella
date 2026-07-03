import { listFlowRunsHandler } from "@/api/handlers/flows/run-read";
import {
  flowRunsWorkspaceParamsSchema,
  listFlowRunsQuerySchema,
} from "@/api/handlers/flows/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "pending" },
  params: flowRunsWorkspaceParamsSchema,
  query: listFlowRunsQuerySchema,
} satisfies HandlerConfig;

const listFlowRuns = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    return yield* listFlowRunsHandler({ safeDb, workspaceId, query });
  },
);

export default listFlowRuns;
