import { Result } from "better-result";

import { flowRunParamsSchema } from "@/api/handlers/flows/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { cancelFlowRun } from "@/api/lib/flows/flow-executor";

const config = {
  permissions: { flow: ["run"] },
  mcp: { type: "pending" },
  params: flowRunParamsSchema,
} satisfies HandlerConfig;

const cancelFlowRunHandler = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, recordAuditEvent }) {
    const cancelled = yield* Result.await(
      cancelFlowRun({ safeDb, workspaceId, runId: params.runId }),
    );

    yield* Result.await(
      safeDb((tx) =>
        recordAuditEvent(tx, {
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
