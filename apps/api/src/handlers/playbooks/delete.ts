import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { playbookDefinitions } from "@/api/db/schema";
import { playbookDefinitionParamsSchema } from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Permanently delete a playbook definition and every approved version of " +
    "it from the organization. Columns the playbook materialized into matters " +
    "are kept: they keep their extracted answers and verdicts and continue to " +
    "work as ordinary columns, no longer owned by any playbook. Recorded " +
    "review findings are kept as well. There is no in-use check.",
  permissions: { playbook: ["delete"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: playbookDefinitionParamsSchema,
} satisfies HandlerConfig;

const deletePlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        // Confirm org ownership before deleting anything, so a foreign
        // playbookId can never reach another org's definition.
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

        // The materialized columns are deliberately left standing. The
        // `playbook_definition_id` reference is ON DELETE SET NULL, so they are
        // orphaned rather than dropped: each keeps the answers and verdicts it
        // already holds for every document, keeps grading from the rules copied
        // into its `tool`, and is re-adopted by `playbook_source_id` if the
        // playbook is recreated and run again.
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
