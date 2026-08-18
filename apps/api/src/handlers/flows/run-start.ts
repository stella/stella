import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDbError } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import {
  flowRunsWorkspaceParamsSchema,
  startFlowRunBodySchema,
} from "@/api/handlers/flows/schema";
import {
  assertRunSizeConfirmedForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { estimateFlowRunUnits } from "@/api/lib/flows/flow-run-estimate";
import {
  FlowRunStartError,
  startFlowRun,
} from "@/api/lib/flows/start-flow-run";
import { getTanStackTextModelInfoForRole } from "@/api/lib/tanstack-ai-models";

const config = {
  description:
    "Start a manual flow run in a matter using a flow definition and optional input documents. Returns the run ID and initial status.",
  permissions: { flow: ["run"] },
  access: "write",
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: flowRunsWorkspaceParamsSchema,
  body: startFlowRunBodySchema,
} satisfies HandlerConfig;

const startFlowRunHandler = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    session,
    body,
    user,
    orgAIConfig,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;

    // The input documents must belong to this workspace (ownership comes from
    // the validated path, not the body).
    if (body.inputEntityIds.length > 0) {
      const owned = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ id: entities.id })
            .from(entities)
            .where(
              and(
                eq(entities.workspaceId, workspaceId),
                inArray(entities.id, body.inputEntityIds),
              ),
            ),
        ),
      );
      const ownedIds = new Set(owned.map((row) => row.id));
      const foreign = body.inputEntityIds.filter((id) => !ownedIds.has(id));
      if (foreign.length > 0) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "An input document does not belong to this workspace.",
          }),
        );
      }
    }

    const started = yield* Result.await(
      startFlowRun({
        safeDb,
        organizationId,
        workspaceId,
        definitionId: body.definitionId,
        triggerSource: { type: "manual", userId: user.id },
        inputEntityIds: body.inputEntityIds,
        // Size the whole run before any row is written: every AI step's
        // prompt is bounded by the executor's caps, so the estimate is an
        // upper bound. Large runs need the client to restate it.
        admit: async ({ steps }) => {
          const stepModel = getTanStackTextModelInfoForRole(
            "chat",
            orgAIConfig,
            { organizationId },
          );
          return await assertRunSizeConfirmedForHandler({
            metering: { actionType: "background", modelRole: "chat" },
            estimatedUnits: estimateFlowRunUnits({
              modelId: stepModel.modelId,
              steps,
              inputEntityCount: body.inputEntityIds.length,
            }),
            confirmedUnits: body.confirmedUnits,
            organizationId,
            orgAIConfig,
            workspaceId,
            userId: user.id,
            safeDb,
          });
        },
      }).then((result) => Result.mapError(result, toHandlerError)),
    );

    yield* Result.await(
      safeDb(
        async (tx) =>
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.EXECUTE,
            resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
            resourceId: started.runId,
            metadata: { definitionId: body.definitionId },
          }),
      ),
    );

    return Result.ok({ runId: started.runId, status: started.status });
  },
);

const toHandlerError = (
  error: FlowRunStartError | SafeDbError,
): HandlerError => {
  if (FlowRunStartError.is(error)) {
    switch (error.reason) {
      case "definition-not-found":
        return new HandlerError({ status: 404, message: error.message });
      case "definition-disabled":
        return new HandlerError({ status: 409, message: error.message });
      case "admission-refused":
        // The pre-flight's own 402/428 (with its structured detail) is the
        // response; the wrapper only carried it out of startFlowRun.
        if (HandlerError.is(error.cause)) {
          return error.cause;
        }
        return new HandlerError({ status: 500, message: error.message });
      case "enqueue-failed":
        return new HandlerError({
          status: 500,
          message: error.message,
          cause: error,
        });
    }
  }
  return new HandlerError({
    status: 500,
    message: "Failed to start the flow run",
    cause: error,
  });
};

export default startFlowRunHandler;
