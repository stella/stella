import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { playbookDefinitions } from "@/api/db/schema";
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
        const [row] = await tx
          .delete(playbookDefinitions)
          .where(
            and(
              eq(playbookDefinitions.id, params.playbookId),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          )
          .returning({
            id: playbookDefinitions.id,
            name: playbookDefinitions.name,
          });

        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
            resourceId: params.playbookId,
            changes: { deleted: { old: { name: row.name }, new: null } },
          });
        }

        return row;
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
