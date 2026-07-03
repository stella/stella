import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { flowDefinitions } from "@/api/db/schema";
import { flowDefinitionBodySchema } from "@/api/handlers/flows/schema";
import { parseAndValidateFlowDefinition } from "@/api/handlers/flows/validate-definition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { syncFlowScheduleTrigger } from "@/api/lib/flows/sync-flow-schedule-trigger";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { flow: ["create"] },
  mcp: { type: "pending" },
  body: flowDefinitionBodySchema,
} satisfies HandlerConfig;

const createFlowDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent, user }) {
    const organizationId = session.activeOrganizationId;

    const input = yield* Result.await(
      parseAndValidateFlowDefinition({ safeDb, organizationId, body }),
    );

    const existingCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          flowDefinitions,
          eq(flowDefinitions.organizationId, organizationId),
        ),
      ),
    );
    if (existingCount >= LIMITS.flowDefinitionsCount) {
      return Result.err(
        new HandlerError({ status: 400, message: "Flow limit reached" }),
      );
    }

    const flowId = createSafeId<"flowDefinition">();

    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .insert(flowDefinitions)
          .values({
            id: flowId,
            organizationId,
            name: input.name,
            description: input.description,
            steps: input.steps,
            trigger: input.trigger,
            enabled: input.enabled,
            createdByUserId: user.id,
          })
          .returning({ id: flowDefinitions.id });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.FLOW_DEFINITION,
          resourceId: flowId,
          changes: {
            created: {
              old: null,
              new: {
                name: input.name,
                stepCount: input.steps.length,
                triggerType: input.trigger.type,
                enabled: input.enabled,
              },
            },
          },
        });

        return row;
      }),
    );

    if (!inserted) {
      panic("Failed to create flow definition");
    }

    // Phase 3 seam: keep the scheduler row in sync with the trigger.
    syncFlowScheduleTrigger({
      id: flowId,
      trigger: input.trigger,
      enabled: input.enabled,
    });

    return Result.ok({ id: inserted.id });
  },
);

export default createFlowDefinition;
