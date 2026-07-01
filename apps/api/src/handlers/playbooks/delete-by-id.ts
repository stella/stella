import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { playbookDefinitions, properties } from "@/api/db/schema";
import { playbookDefinitionParamsSchema } from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { playbook: ["delete"] },
  params: playbookDefinitionParamsSchema,
} satisfies HandlerConfig;

const deletePlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        // Confirm org ownership before deleting any rows, so a foreign
        // playbookId can't delete another org's materialized columns below.
        const playbook = await tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: params.playbookId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, name: true },
        });
        if (!playbook) {
          return null;
        }

        // Delete materialized columns in dependency order before the definition:
        // a verdict property depends on its ASK via an ON DELETE RESTRICT edge,
        // so the playbook_definition_id cascade alone fails for a playbook that
        // has been run. Verdict rows (and their dependency edges) go first, then
        // the ASK columns.
        const owned = await tx
          .select({ id: properties.id, tool: properties.tool })
          .from(properties)
          .where(eq(properties.playbookDefinitionId, params.playbookId));
        const verdictIds = owned
          .filter((property) => property.tool.type === "playbook-verdict")
          .map((property) => property.id);
        const askIds = owned
          .filter((property) => property.tool.type !== "playbook-verdict")
          .map((property) => property.id);
        if (verdictIds.length > 0) {
          await tx.delete(properties).where(inArray(properties.id, verdictIds));
        }
        if (askIds.length > 0) {
          await tx.delete(properties).where(inArray(properties.id, askIds));
        }

        await tx
          .delete(playbookDefinitions)
          .where(
            and(
              eq(playbookDefinitions.id, params.playbookId),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: params.playbookId,
          changes: { deleted: { old: { name: playbook.name }, new: null } },
        });

        return playbook;
      }),
    );

    if (!deleted) {
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    }

    return Result.ok({});
  },
);

export default deletePlaybookDefinition;
