import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isDeferredServiceTierAvailableForRole } from "@/api/lib/tanstack-ai-models";
import { startWorkflow } from "@/api/lib/workflow-queue";
import { isReportedWorkflowStartStatus } from "@/api/lib/workflow/workflow-start-disposition";

const config = {
  description:
    "Start an extraction workflow in a matter, filling the AI columns of the " +
    "documents that need it. Narrow it with entityIds and propertyIds, set " +
    "the processing order with entityIdsOrder, and choose serviceTier " +
    "standard or flex, where flex is the cheaper deferred tier and is " +
    "refused when the configured provider does not offer it. Returns the " +
    "run's status, including already-running when one is in flight.",
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: t.Object({
    // A run targets documents of one matter, so the matter's own entity cap
    // is the most a caller can name. `matters.read-workflow-target-count`
    // carries the same bound so a sizeable set is always a startable one.
    entityIds: t.Optional(
      t.Array(tSafeId("entity"), { maxItems: LIMITS.entitiesCount }),
    ),
    entityIdsOrder: t.Optional(
      t.Array(tSafeId("entity"), { maxItems: LIMITS.entitiesCount }),
    ),
    propertyIds: t.Optional(
      t.Array(tSafeId("property"), { maxItems: LIMITS.propertiesCount }),
    ),
    serviceTier: t.Optional(
      t.Union([t.Literal("standard"), t.Literal("flex")]),
    ),
  }),
} satisfies HandlerConfig;

export type WorkflowStartDependencies = {
  startWorkflow: typeof startWorkflow;
};

const defaultWorkflowStartDependencies = {
  startWorkflow,
} satisfies WorkflowStartDependencies;

export const createWorkflowStart = (
  dependencies: WorkflowStartDependencies = defaultWorkflowStartDependencies,
) =>
  createSafeHandler(
    config,
    async function* ({
      workspaceId,
      session,
      user,
      scopedDb,
      body,
      orgAIConfig,
    }) {
      if (
        body.serviceTier === "flex" &&
        !isDeferredServiceTierAvailableForRole("pdf", orgAIConfig)
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "Reduced-credit workflow extraction is not available for the configured AI provider.",
          }),
        );
      }

      const { status } = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await dependencies.startWorkflow({
              workspaceId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              scopedDb,
              ...(body.entityIds && { entityIds: body.entityIds }),
              ...(body.entityIdsOrder && {
                entityIdsOrder: body.entityIdsOrder,
              }),
              ...(body.propertyIds && { propertyIds: body.propertyIds }),
              ...(body.serviceTier && { serviceTier: body.serviceTier }),
            }),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Internal server error",
              cause,
            }),
        }),
      );

      // The queue answers a failed enqueue as a status, so returning it verbatim
      // would report a workflow that will never run as a 200.
      if (!isReportedWorkflowStartStatus(status)) {
        return Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to start the workflow",
          }),
        );
      }

      return Result.ok({ status });
    },
  );

const workflowStart = createWorkflowStart();

export default workflowStart;
