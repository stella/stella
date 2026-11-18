import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { flowDefinitions } from "@/api/db/schema";
import {
  flowDefinitionParamsSchema,
  updateFlowDefinitionBodySchema,
} from "@/api/handlers/flows/schema";
import { parseAndValidateFlowDefinition } from "@/api/handlers/flows/validate-definition";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { syncFlowScheduleTrigger } from "@/api/lib/flows/sync-flow-schedule-trigger";
import { enforceWritePrecondition } from "@/api/lib/write-contract/write-contract";

const config = {
  contract: "replace",
  precondition: {
    type: "updatedAt",
    field: "expectedUpdatedAt",
  },
  description:
    "Replace one flow definition's name, description, steps, trigger, and " +
    "enabled flag. The whole definition is revalidated and written, so this " +
    "is not a partial update. Read flows.get and send its updatedAt as " +
    "expectedUpdatedAt; stale snapshots return HTTP 409 (version_conflict) " +
    "without writing. After a conflict, read the current definition and reconcile " +
    "the intended changes before retrying. The scheduler row is reconciled afterwards, so " +
    "changing or removing a schedule trigger, or disabling the flow, also " +
    "stops it from firing.",
  permissions: { flow: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  params: flowDefinitionParamsSchema,
  body: updateFlowDefinitionBodySchema,
} satisfies HandlerConfig;

const updateFlowDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const { expectedUpdatedAt: _expectedUpdatedAt, ...definitionBody } = body;

    const input = yield* Result.await(
      parseAndValidateFlowDefinition({
        safeDb,
        organizationId,
        body: definitionBody,
      }),
    );

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const acquisition = await withAggregateRowQuery({
          aggregate: "definition",
          id: { id: params.flowId, organizationId },
          tx,
          mode: "update",
          select: (lockTx) => lockTx.select().from(flowDefinitions),
        });
        const locked = acquisition.rows.at(0);
        if (!locked) {
          return Result.err(
            new HandlerError({ status: 404, message: "Flow not found" }),
          );
        }
        const conflict = enforceWritePrecondition({
          type: "updatedAt",
          field: "expectedUpdatedAt",
          storedUpdatedAt: locked.updatedAt,
          expectedUpdatedAt: body.expectedUpdatedAt,
          resource: "Flow",
        });
        if (conflict) {
          return Result.err(conflict);
        }

        const [row] = await tx
          .update(flowDefinitions)
          .set({
            name: input.name,
            description: input.description,
            steps: input.steps,
            trigger: input.trigger,
            enabled: input.enabled,
            // Wire tokens have millisecond precision; every committed write
            // must invalidate even a snapshot read in the same clock tick.
            updatedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', ${flowDefinitions.updatedAt}) + interval '1 millisecond')`,
          })
          .where(
            and(
              eq(flowDefinitions.id, params.flowId),
              eq(flowDefinitions.organizationId, organizationId),
            ),
          )
          .returning({
            id: flowDefinitions.id,
            updatedAt: flowDefinitions.updatedAt,
          });
        if (!row) {
          return panic("Locked flow definition disappeared before update");
        }

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

        return Result.ok(row);
      }),
    );

    const definition = yield* updated;

    // A changed / removed schedule trigger (or a disabled flow) must reconcile
    // the scheduler row (post-commit; never throws).
    await syncFlowScheduleTrigger({
      id: params.flowId,
      organizationId,
    });

    return Result.ok({
      id: definition.id,
      updatedAt: definition.updatedAt.toISOString(),
    });
  },
);

declareAggregateMutation(updateFlowDefinition, {
  type: "aggregate",
  aggregates: ["definition"],
});

export default updateFlowDefinition;
