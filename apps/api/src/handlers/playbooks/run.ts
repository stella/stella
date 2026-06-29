import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import { properties, propertyDependencies } from "@/api/db/schema";
import type {
  PlaybookVerdictTool,
  PropertyTool,
} from "@/api/db/schema-validators";
import type {
  Position,
  ResolvedStandard,
} from "@/api/handlers/playbooks/positions";
import {
  loadClauseSnapshots,
  resolveStandard,
} from "@/api/handlers/playbooks/resolve-standards";
import { buildVerdictContent } from "@/api/handlers/playbooks/verdict-tiers";
import { createDefaultTool } from "@/api/handlers/properties/create-schema";
import { lockWorkspacePropertyWrites } from "@/api/handlers/properties/property-lock";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { remapNodePropertyIds } from "@/api/lib/conditions/ast-utils";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { playbook: ["apply"] },
  params: workspaceParams({ playbookId: tSafeId("playbookDefinition") }),
} satisfies HandlerConfig;

const buildAskTool = (position: Position): PropertyTool => {
  const question = position.ask.question.trim();
  const useAi = position.ask.content.type !== "file" && question.length > 0;
  return createDefaultTool({
    dependencies: [],
    prompt: useAi ? question : undefined,
    toolType: useAi ? "ai-model" : "manual-input",
  });
};

const buildVerdictTool = ({
  askPropertyId,
  position,
  standard,
}: {
  askPropertyId: SafeId<"property">;
  position: Position;
  standard: ResolvedStandard;
}): PlaybookVerdictTool => {
  // A propertyConstraint condition is authored against the position's own value
  // via a `property` operand whose id is the position `sourceId`; rewrite that
  // self-reference to the materialized ASK property so the verdict engine
  // evaluates the condition over the real extracted field.
  const rule =
    position.rule.kind === "propertyConstraint"
      ? {
          kind: "propertyConstraint" as const,
          condition: remapNodePropertyIds(position.rule.condition, (id) =>
            id === position.sourceId ? askPropertyId : id,
          ),
        }
      : position.rule;

  return {
    version: 1,
    type: "playbook-verdict",
    askPropertyId,
    rule,
    severity: position.severity,
    standard,
  };
};

const runPlaybook = createSafeHandler(
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
    const organizationId = session.activeOrganizationId;

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const playbook = await tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: params.playbookId },
            organizationId: { eq: organizationId },
          },
          columns: { positions: true },
        });
        if (!playbook) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Playbook not found",
          };
        }

        const positions = playbook.positions.items;
        if (positions.length === 0) {
          return { ok: true as const, materializedPropertyIds: [] };
        }

        await lockWorkspacePropertyWrites(tx, workspaceId);

        const clauseSnapshots = await loadClauseSnapshots(
          tx,
          organizationId,
          positions,
        );

        const sourceIds = positions.map((position) => position.sourceId);
        const owned = await tx
          .select({
            id: properties.id,
            playbookSourceId: properties.playbookSourceId,
            tool: properties.tool,
          })
          .from(properties)
          .where(
            and(
              eq(properties.workspaceId, workspaceId),
              inArray(properties.playbookSourceId, sourceIds),
            ),
          );

        // ASK vs verdict materialized columns share a position's sourceId; the
        // tool type disambiguates which existing row to update in place.
        const askIdBySourceId = new Map<string, SafeId<"property">>();
        const verdictIdBySourceId = new Map<string, SafeId<"property">>();
        for (const row of owned) {
          if (row.playbookSourceId === null) {
            continue;
          }
          if (row.tool.type === "playbook-verdict") {
            verdictIdBySourceId.set(row.playbookSourceId, row.id);
          } else {
            askIdBySourceId.set(row.playbookSourceId, row.id);
          }
        }

        const existingCount = await tx.$count(
          properties,
          eq(properties.workspaceId, workspaceId),
        );

        const askRows: (typeof properties.$inferInsert)[] = [];
        const verdictRows: (typeof properties.$inferInsert)[] = [];
        const dependencyRows: (typeof propertyDependencies.$inferInsert)[] = [];
        const materializedPropertyIds: SafeId<"property">[] = [];
        let newCount = 0;

        for (const position of positions) {
          const askTool = buildAskTool(position);
          const askId =
            askIdBySourceId.get(position.sourceId) ??
            createSafeId<"property">();
          if (!askIdBySourceId.has(position.sourceId)) {
            newCount += 1;
          }

          askRows.push({
            id: askId,
            workspaceId,
            name: position.issue,
            content: position.ask.content,
            tool: askTool,
            status: askTool.type === "ai-model" ? "stale" : "fresh",
            playbookSourceId: position.sourceId,
          });
          materializedPropertyIds.push(askId);

          if (position.rule.kind === "extractOnly") {
            continue;
          }

          const verdictId =
            verdictIdBySourceId.get(position.sourceId) ??
            createSafeId<"property">();
          if (!verdictIdBySourceId.has(position.sourceId)) {
            newCount += 1;
          }

          verdictRows.push({
            id: verdictId,
            workspaceId,
            name: `${position.issue} (verdict)`.slice(0, 256),
            content: buildVerdictContent(),
            tool: buildVerdictTool({
              askPropertyId: askId,
              position,
              standard: resolveStandard(position, clauseSnapshots),
            }),
            status: "stale",
            playbookSourceId: position.sourceId,
          });
          materializedPropertyIds.push(verdictId);

          // The verdict is graded after its ASK extraction; the DAG schedules
          // it a level later via this dependency (no gate condition).
          dependencyRows.push({
            workspaceId,
            propertyId: verdictId,
            dependsOnPropertyId: askId,
            condition: null,
          });
        }

        if (existingCount + newCount > LIMITS.propertiesCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Properties limit reached",
          };
        }

        const upsertProperties = async (
          rows: (typeof properties.$inferInsert)[],
        ) => {
          if (rows.length === 0) {
            return;
          }
          // audit: skip — the playbook run is audited once via recordAuditEvent in
          // the enclosing transaction; this helper only upserts materialized rows.
          await tx
            .insert(properties)
            .values(rows)
            .onConflictDoUpdate({
              target: properties.id,
              set: {
                name: sql`excluded.name`,
                content: sql`excluded.content`,
                tool: sql`excluded.tool`,
                status: sql`excluded.status`,
              },
            });
        };

        // ASK rows first so the verdict rows' `askPropertyId` FK targets exist.
        await upsertProperties(askRows);
        await upsertProperties(verdictRows);

        if (dependencyRows.length > 0) {
          await tx
            .insert(propertyDependencies)
            .values(dependencyRows)
            .onConflictDoUpdate({
              target: [
                propertyDependencies.propertyId,
                propertyDependencies.dependsOnPropertyId,
              ],
              set: { condition: sql`excluded.condition` },
            });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: params.playbookId,
          changes: {
            run: {
              old: null,
              new: {
                materializedPropertyCount: materializedPropertyIds.length,
              },
            },
          },
        });

        return { ok: true as const, materializedPropertyIds };
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

    if (txResult.materializedPropertyIds.length === 0) {
      return Result.ok({ runPropertyCount: 0 });
    }

    yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await startWorkflow({
            workspaceId,
            organizationId,
            userId: user.id,
            scopedDb,
            propertyIds: txResult.materializedPropertyIds,
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
      runPropertyCount: txResult.materializedPropertyIds.length,
    });
  },
);

export default runPlaybook;
