import { Result } from "better-result";

import {
  flowRunParamsSchema,
  reviewFlowRunBodySchema,
} from "@/api/handlers/flows/schema";
import { flowRunRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resolveFlowReviewGate } from "@/api/lib/flows/flow-executor";

const config = {
  featureAccess: { featureId: "flows", type: "required" },
  description:
    "Resolve a flow run waiting at a review gate: pass decision approved or " +
    "rejected, with an optional note. The run continues or stops " +
    "accordingly, and its id and new status come back.",
  permissions: { flow: ["review"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: flowRunRealtimeUpdates,
  access: "write",
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  params: flowRunParamsSchema,
  body: reviewFlowRunBodySchema,
} satisfies WorkspaceHandlerConfig;

const reviewFlowRun = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params,
    body,
    session,
    user,
    recordAuditEvent,
  }) {
    const resolved = yield* Result.await(
      resolveFlowReviewGate({
        safeDb,
        workspaceId,
        organizationId: session.activeOrganizationId,
        runId: params.runId,
        userId: user.id,
        decision: body.decision,
        note: body.note ?? null,
        recordAuditEvent,
      }),
    );

    return Result.ok({ runId: resolved.runId, status: resolved.status });
  },
);

export default reviewFlowRun;
