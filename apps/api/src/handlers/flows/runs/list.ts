import { listFlowRunsHandler } from "@/api/handlers/flows/run-read";
import {
  flowRunsWorkspaceParamsSchema,
  listFlowRunsQuerySchema,
} from "@/api/handlers/flows/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/demo-account-policy";

const config = {
  description:
    "List flow runs in a matter, including lifecycle state and pagination metadata.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  access: "read",
  params: flowRunsWorkspaceParamsSchema,
  query: listFlowRunsQuerySchema,
} satisfies WorkspaceHandlerConfig;

const listFlowRuns = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    return yield* listFlowRunsHandler({ safeDb, workspaceId, query });
  },
);

export default listFlowRuns;
