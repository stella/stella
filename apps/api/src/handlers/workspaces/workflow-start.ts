import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isDeferredServiceTierAvailableForRole } from "@/api/lib/tanstack-ai-models";
import { startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: t.Object({
    entityIds: t.Optional(t.Array(tSafeId("entity"))),
    entityIdsOrder: t.Optional(t.Array(tSafeId("entity"))),
    propertyIds: t.Optional(
      t.Array(tSafeId("property"), { maxItems: LIMITS.propertiesCount }),
    ),
    serviceTier: t.Optional(
      t.Union([t.Literal("standard"), t.Literal("flex")]),
    ),
  }),
} satisfies HandlerConfig;

const workflowStart = createSafeHandler(
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

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await startWorkflow({
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

    return Result.ok(result);
  },
);

export default workflowStart;
