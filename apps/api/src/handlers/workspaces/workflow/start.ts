import { Result } from "better-result";
import * as v from "valibot";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { memberAIAccessError } from "@/api/lib/ai-config-response";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requestExtractionRunStore } from "@/api/lib/extraction-runs/request-run-store";
import { LIMITS } from "@/api/lib/limits";
import { isDeferredServiceTierAvailableForTask } from "@/api/lib/tanstack-ai-models";
import { startWorkflow } from "@/api/lib/workflow-queue";
import { readStaleCellTargets } from "@/api/lib/workflow/stale-cells";
import { isReportedWorkflowStartStatus } from "@/api/lib/workflow/workflow-start-disposition";

const config = {
  contract: "patch",
  description:
    "Start an extraction workflow in a matter, filling the AI columns of the " +
    "documents that need it. Narrow it with entityIds and propertyIds, set " +
    "the processing order with entityIdsOrder, and choose serviceTier " +
    "standard or flex, where flex is the cheaper deferred tier and is " +
    "refused when the configured provider does not offer it. cells: stale " +
    "runs only the documents and columns holding an outcome settled before " +
    "a new document version changed its inputs (skipped when there are " +
    "none); entityIds and propertyIds then narrow it further. Returns the " +
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
    cells: v.optional(v.picklist(["stale"])),
  }),
} satisfies WorkspaceHandlerConfig;

type RunTargets = {
  entityIds: SafeId<"entity">[] | undefined;
  propertyIds: SafeId<"property">[] | undefined;
};

const narrowTo = <T extends string>(
  found: T[],
  requested: T[] | undefined,
): T[] =>
  requested === undefined
    ? found
    : found.filter((id) => requested.includes(id));

/**
 * The run's document and column filters: the request's own, or, for stale
 * cells, the stale set narrowed by them. Null when no stale cell is left.
 */
const resolveRunTargets = async ({
  body,
  safeDb,
  workspaceId,
}: {
  body: v.InferOutput<typeof config.body>;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
}): Promise<Result<RunTargets | null, SafeDbError>> => {
  if (body.cells !== "stale") {
    return Result.ok({
      entityIds: body.entityIds,
      propertyIds: body.propertyIds,
    });
  }
  const stale = await safeDb((tx) => readStaleCellTargets({ tx, workspaceId }));
  return stale.map((found) => {
    const entityIds = narrowTo(found.entityIds, body.entityIds);
    const propertyIds = narrowTo(found.propertyIds, body.propertyIds);
    return entityIds.length === 0 || propertyIds.length === 0
      ? null
      : { entityIds, propertyIds };
  });
};

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
      safeDb,
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

      const targets = yield* Result.await(
        resolveRunTargets({ body, safeDb, workspaceId }),
      );
      if (targets === null) {
        return Result.ok({ status: "skipped" as const });
      }

      const { status } = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await dependencies.startWorkflow({
              workspaceId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              scopedDb,
              ...(targets.entityIds && { entityIds: targets.entityIds }),
              ...(body.entityIdsOrder && {
                entityIdsOrder: body.entityIdsOrder,
              }),
              ...(targets.propertyIds && { propertyIds: targets.propertyIds }),
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
