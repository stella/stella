import { Result } from "better-result";

import {
  flowRunParamsSchema,
  reviewFlowRunBodySchema,
} from "@/api/handlers/flows/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resolveFlowReviewGate } from "@/api/lib/flows/flow-executor";

const config = {
  description:
    "Resolve a flow run waiting at a review gate: pass decision approved or " +
    "rejected, with an optional note. The run continues or stops " +
    "accordingly, and its id and new status come back.",
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
