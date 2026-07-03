import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { flowDefinitions } from "@/api/db/schema";
import { flowDefinitionParamsSchema } from "@/api/handlers/flows/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { syncFlowScheduleTrigger } from "@/api/lib/flows/sync-flow-schedule-trigger";

const config = {
  permissions: { flow: ["delete"] },
  mcp: { type: "pending" },
  params: flowDefinitionParamsSchema,
} satisfies HandlerConfig;

const deleteFlowDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const definition = await tx.query.flowDefinitions.findFirst({
          where: {
            id: { eq: params.flowId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, name: true, trigger: true, enabled: true },
        });
        if (!definition) {
          return null;
        }

        // Runs outlive their definition: `flow_runs.definition_id` is
        // ON DELETE SET NULL and each run keeps a self-contained snapshot, so
        // deleting the definition never destroys run history.
        await tx
          .delete(flowDefinitions)
          .where(
            and(
              eq(flowDefinitions.id, params.flowId),
              eq(flowDefinitions.organizationId, organizationId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.FLOW_DEFINITION,
          resourceId: params.flowId,
          changes: { deleted: { old: { name: definition.name }, new: null } },
        });

        return definition;
      }),
    );

    if (!deleted) {
      return Result.err(
        new HandlerError({ status: 404, message: "Flow not found" }),
      );
    }

    // Remove the scheduler row for a deleted definition (post-commit; never
    // throws).
    await syncFlowScheduleTrigger({
      id: deleted.id,
      trigger: deleted.trigger,
      enabled: false,
    });

    return Result.ok({});
  },
);

export default deleteFlowDefinition;
