import { Result } from "better-result";

import {
  flowRunParamsSchema,
  reviewFlowRunBodySchema,
} from "@/api/handlers/flows/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resolveFlowReviewGate } from "@/api/lib/flows/flow-executor";

const config = {
  permissions: { flow: ["review"] },
  access: "write",
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: flowRunParamsSchema,
  body: reviewFlowRunBodySchema,
} satisfies HandlerConfig;

const reviewFlowRun = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params,
    body,
    user,
    recordAuditEvent,
  }) {
    const resolved = yield* Result.await(
      resolveFlowReviewGate({
        safeDb,
        workspaceId,
        runId: params.runId,
        userId: user.id,
        decision: body.decision,
        note: body.note ?? null,
      }),
    );

    yield* Result.await(
      safeDb(
        async (tx) =>
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.REVIEW,
            resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
            resourceId: params.runId,
            changes: {
              review: { old: null, new: { decision: body.decision } },
            },
          }),
      ),
    );

    return Result.ok({ runId: resolved.runId, status: resolved.status });
  },
);

export default reviewFlowRun;
