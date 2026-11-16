import { Result } from "better-result";

import { flowRunParamsSchema } from "@/api/handlers/flows/schema";
import { flowRunRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { cancelFlowRun } from "@/api/lib/flows/flow-executor";

const config = {
  contract: "patch",
  description:
    "Cancel a flow run that is still in progress in a matter, returning the " +
    "run id and the status it settled on. Work already committed by steps " +
    "that finished is not undone.",
  permissions: { flow: ["run"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: flowRunRealtimeUpdates,
  access: "write",
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  params: flowRunParamsSchema,
} satisfies WorkspaceHandlerConfig;

const cancelFlowRunHandler = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, user, recordAuditEvent }) {
    const cancelled = yield* Result.await(
      cancelFlowRun({
        safeDb,
        workspaceId,
        runId: params.runId,
        userId: user.id,
        recordAuditEvent,
      }),
    );

    return Result.ok({ runId: cancelled.runId, status: cancelled.status });
  },
);

export default cancelFlowRunHandler;
