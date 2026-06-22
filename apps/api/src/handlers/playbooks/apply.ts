import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { ConditionNode } from "@stll/conditions";

import { properties, propertyDependencies } from "@/api/db/schema";
import type { PlaybookBundleColumn } from "@/api/db/schema-validators";
import { playbookParamsSchema } from "@/api/handlers/playbooks/schema";
import { validateTypeProperty } from "@/api/handlers/playbooks/validate";
import { createDefaultTool } from "@/api/handlers/properties/create-schema";
import { lockWorkspacePropertyWrites } from "@/api/handlers/properties/property-lock";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { playbook: ["apply"] },
  params: playbookParamsSchema,
} satisfies HandlerConfig;

const buildGateCondition = (
  typePropertyId: SafeId<"property">,
  typeValue: string,
): ConditionNode => ({
  type: "compare",
  left: { type: "property", propertyId: typePropertyId },
  op: "eq",
  right: { type: "literal", value: typeValue },
});

const toolFor = (column: PlaybookBundleColumn) =>
  createDefaultTool({
    dependencies: [],
    prompt: column.prompt.length > 0 ? column.prompt : undefined,
    toolType:
      column.content.type !== "file" && column.prompt.length > 0
        ? "ai-model"
        : "manual-input",
  });

type ApplyTxResult =
  | { ok: false; status: 400 | 404 | 422; message: string }
  | { ok: true; appliedPropertyIds: SafeId<"property">[] };

const applyPlaybook = createSafeHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    workspaceId,
    params,
    session,
    user,
    recordAuditEvent,
  }) {
    const txResult: ApplyTxResult = yield* Result.await(
      safeDb(async (tx): Promise<ApplyTxResult> => {
        const playbook = await tx.query.playbooks.findFirst({
          where: {
            id: { eq: params.playbookId },
            workspaceId: { eq: workspaceId },
          },
          columns: { typePropertyId: true, typeValue: true, bundle: true },
        });

        if (!playbook) {
          return { ok: false, status: 404, message: "Playbook not found" };
        }

        await lockWorkspacePropertyWrites(tx, workspaceId);

        const typeCheck = await validateTypeProperty({
          tx,
          workspaceId,
          typePropertyId: playbook.typePropertyId,
          typeValue: playbook.typeValue,
        });
        if (!typeCheck.ok) {
          return typeCheck;
        }

        const sourceIds = playbook.bundle.map((column) => column.sourceId);

        const existingCount = (
          await tx
            .select({ id: properties.id })
            .from(properties)
            .where(eq(properties.workspaceId, workspaceId))
        ).length;

        // Re-applying matches a bundle column to the property it previously
        // materialized by `playbookSourceId`, so renames update in place and
        // a shared column name across playbooks never reuses another's
        // property (each column owns a distinct source id).
        const owned = await tx
          .select({
            id: properties.id,
            playbookSourceId: properties.playbookSourceId,
          })
          .from(properties)
          .where(
            and(
              eq(properties.workspaceId, workspaceId),
              inArray(properties.playbookSourceId, sourceIds),
            ),
          );
        const ownedIdBySourceId = new Map(
          owned.map((row) => [row.playbookSourceId, row.id]),
        );

        const condition = buildGateCondition(
          playbook.typePropertyId,
          playbook.typeValue,
        );

        let newCount = 0;
        const upsertRows: (typeof properties.$inferInsert)[] = [];
        for (const column of playbook.bundle) {
          const ownedId = ownedIdBySourceId.get(column.sourceId);
          if (ownedId === undefined) {
            newCount += 1;
            if (existingCount + newCount > LIMITS.propertiesCount) {
              return {
                ok: false,
                status: 400,
                message: "Properties limit reached",
              };
            }
          }

          const tool = toolFor(column);
          upsertRows.push({
            ...(ownedId !== undefined && { id: ownedId }),
            workspaceId,
            name: column.name,
            content: column.content,
            tool,
            status: tool.type === "ai-model" ? "stale" : "fresh",
            playbookSourceId: column.sourceId,
          });
        }

        const upserted = await tx
          .insert(properties)
          .values(upsertRows)
          .onConflictDoUpdate({
            target: properties.id,
            set: {
              name: sql`excluded.name`,
              content: sql`excluded.content`,
              tool: sql`excluded.tool`,
              status: sql`excluded.status`,
            },
          })
          .returning({ id: properties.id });

        if (upserted.length !== upsertRows.length) {
          return {
            ok: false,
            status: 400,
            message: "Failed to apply playbook columns",
          };
        }

        const appliedPropertyIds = upserted.map((row) => row.id);

        await tx
          .insert(propertyDependencies)
          .values(
            appliedPropertyIds.map((propertyId) => ({
              workspaceId,
              propertyId,
              dependsOnPropertyId: playbook.typePropertyId,
              condition,
            })),
          )
          .onConflictDoUpdate({
            target: [
              propertyDependencies.propertyId,
              propertyDependencies.dependsOnPropertyId,
            ],
            set: { condition },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: params.playbookId,
          changes: {
            applied: {
              old: null,
              new: { appliedColumnCount: appliedPropertyIds.length },
            },
          },
        });

        return { ok: true, appliedPropertyIds };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    if (txResult.appliedPropertyIds.length === 0) {
      return Result.ok({ appliedColumnCount: 0 });
    }

    // Re-run every applied column (newly created and updated-in-place), so a
    // re-apply after an edit re-extracts under the current gate.
    yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await startWorkflow({
            workspaceId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            scopedDb,
            propertyIds: txResult.appliedPropertyIds,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );

    return Result.ok({
      appliedColumnCount: txResult.appliedPropertyIds.length,
    });
  },
);

export default applyPlaybook;
