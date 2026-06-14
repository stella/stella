import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { playbooks } from "@/api/db/schema";
import { playbookParamsSchema } from "@/api/handlers/playbooks/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { playbook: ["delete"] },
  params: playbookParamsSchema,
} satisfies HandlerConfig;

const deletePlaybookById = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, recordAuditEvent }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(playbooks)
          .where(
            and(
              eq(playbooks.id, params.playbookId),
              eq(playbooks.workspaceId, workspaceId),
            ),
          )
          .returning({ id: playbooks.id });

        if (rows.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
            resourceId: params.playbookId,
            changes: { deleted: { old: { id: params.playbookId }, new: null } },
          });
        }

        return rows;
      }),
    );

    if (deleted.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    }

    return Result.ok({});
  },
);

export default deletePlaybookById;
