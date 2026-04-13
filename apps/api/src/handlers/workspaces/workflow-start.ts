import { t } from "elysia";

import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    entityIds: t.Optional(t.Array(tNanoid)),
    entityIdsOrder: t.Optional(t.Array(tNanoid)),
  }),
} satisfies HandlerConfig;

const workflowStart = createHandler(
  config,
  async ({ workspaceId, session, user, scopedDb, body }) => {
    const result = await startWorkflow({
      workspaceId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      scopedDb,
      ...(body.entityIds && { entityIds: body.entityIds }),
      ...(body.entityIdsOrder && { entityIdsOrder: body.entityIdsOrder }),
    });

    return result;
  },
);

export default workflowStart;
