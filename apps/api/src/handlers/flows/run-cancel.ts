import { Result } from "better-result";

import { flowRunParamsSchema } from "@/api/handlers/flows/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { cancelFlowRun } from "@/api/lib/flows/flow-executor";

const config = {
  description:
    "Cancel a flow run that is still in progress in a matter, returning the " +
    "run id and the status it settled on. Work already committed by steps " +
    "that finished is not undone.",
  permissions: { flow: ["run"] },
  access: "write",
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: flowRunParamsSchema,
} satisfies HandlerConfig;

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

    yield* Result.await(
      safeDb(
        async (tx) =>
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CANCEL,
            resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
            resourceId: params.runId,
          }),
      ),
    );

    return Result.ok({ runId: cancelled.runId, status: cancelled.status });
  },
);

export default cancelFlowRunHandler;
