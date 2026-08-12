import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { flowDefinitions } from "@/api/db/schema";
import {
  flowDefinitionBodySchema,
  flowDefinitionParamsSchema,
} from "@/api/handlers/flows/schema";
import { parseAndValidateFlowDefinition } from "@/api/handlers/flows/validate-definition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { syncFlowScheduleTrigger } from "@/api/lib/flows/sync-flow-schedule-trigger";

const config = {
  description:
    "Replace one flow definition's name, description, steps, trigger, and " +
    "enabled flag. The whole definition is revalidated and written, so this " +
    "is not a partial update. The scheduler row is reconciled afterwards, so " +
    "changing or removing a schedule trigger, or disabling the flow, also " +
    "stops it from firing.",
  permissions: { flow: ["update"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: flowDefinitionParamsSchema,
  body: flowDefinitionBodySchema,
} satisfies HandlerConfig;

const updateFlowDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    const input = yield* Result.await(
      parseAndValidateFlowDefinition({ safeDb, organizationId, body }),
    );

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.flowDefinitions.findFirst({
          where: {
            id: { eq: params.flowId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        });
        if (!existing) {
          return null;
        }

        const [row] = await tx
          .update(flowDefinitions)
          .set({
            name: input.name,
            description: input.description,
            steps: input.steps,
            trigger: input.trigger,
            enabled: input.enabled,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(flowDefinitions.id, params.flowId),
              eq(flowDefinitions.organizationId, organizationId),
            ),
          )
          .returning({ id: flowDefinitions.id });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.FLOW_DEFINITION,
          resourceId: params.flowId,
          changes: {
            fields: {
              old: null,
              new: ["name", "description", "steps", "trigger", "enabled"],
            },
          },
        });

        return row ?? null;
      }),
    );

    if (!updated) {
      return Result.err(
        new HandlerError({ status: 404, message: "Flow not found" }),
      );
    }

    // A changed / removed schedule trigger (or a disabled flow) must reconcile
    // the scheduler row (post-commit; never throws).
    await syncFlowScheduleTrigger({
      id: params.flowId,
      trigger: input.trigger,
      enabled: input.enabled,
    });

    return Result.ok({ id: updated.id });
  },
);

export default updateFlowDefinition;
