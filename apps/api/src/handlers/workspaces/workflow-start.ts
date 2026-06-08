import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    entityIds: t.Optional(t.Array(tSafeId("entity"))),
    entityIdsOrder: t.Optional(t.Array(tSafeId("entity"))),
    propertyIds: t.Optional(t.Array(tSafeId("property"))),
    serviceTier: t.Optional(
      t.Union([t.Literal("standard"), t.Literal("flex")]),
    ),
  }),
} satisfies HandlerConfig;

const workflowStart = createSafeHandler(
  config,
  async function* ({ workspaceId, session, user, scopedDb, body }) {
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
