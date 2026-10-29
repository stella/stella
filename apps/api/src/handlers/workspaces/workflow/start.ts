import { Result } from "better-result";
import * as v from "valibot";

import { memberAIAccessError } from "@/api/lib/ai-config-response";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requestExtractionRunStore } from "@/api/lib/extraction-runs/request-run-store";
import { LIMITS } from "@/api/lib/limits";
import { isDeferredServiceTierAvailableForTask } from "@/api/lib/tanstack-ai-models";
import { startWorkflow } from "@/api/lib/workflow-queue";
import { isReportedWorkflowStartStatus } from "@/api/lib/workflow/workflow-start-disposition";

const config = {
  contract: "patch",
  description:
    "Start an extraction workflow in a matter, filling the AI columns of the " +
    "documents that need it. Narrow it with entityIds and propertyIds, set " +
    "the processing order with entityIdsOrder, and choose serviceTier " +
    "standard or flex, where flex is the cheaper deferred tier and is " +
    "refused when the configured provider does not offer it. Returns the " +
    "run's status, including already-running when one is in flight.",
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: true,
  },
  body: v.object({
    entityIds: v.optional(
      v.pipe(
        v.array(resourceIdSchema("entity")),
        v.maxLength(LIMITS.entitiesCount),
      ),
    ),
    entityIdsOrder: v.optional(
      v.pipe(
        v.array(resourceIdSchema("entity")),
        v.maxLength(LIMITS.entitiesCount),
      ),
    ),
    propertyIds: v.optional(
      v.pipe(
        v.array(resourceIdSchema("property")),
        v.maxLength(LIMITS.propertiesCount),
      ),
    ),
    serviceTier: v.optional(v.picklist(["standard", "flex"])),
  }),
} satisfies WorkspaceHandlerConfig;

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
      orgAIConfigStatus,
    }) {
      const accessError = memberAIAccessError(orgAIConfigStatus);
      if (accessError) {
        return Result.err(accessError);
      }
      if (
        body.serviceTier === "flex" &&
        !isDeferredServiceTierAvailableForTask("pdf", orgAIConfig)
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
              extractionRunStore: requestExtractionRunStore,
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
