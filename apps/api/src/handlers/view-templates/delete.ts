import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaceViewTemplates } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  permissions: { view: ["delete"] },
  params: t.Object({
    templateId: tSafeId("workspaceViewTemplate"),
  }),
} satisfies HandlerConfig;

const deleteViewTemplate = createSafeHandler(
  config,
  async function* ({ safeDb, session, user, params, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        const deleted = await tx
          .delete(workspaceViewTemplates)
          .where(
            and(
              eq(workspaceViewTemplates.id, params.templateId),
              eq(
                workspaceViewTemplates.organizationId,
                session.activeOrganizationId,
              ),
              eq(workspaceViewTemplates.userId, user.id),
            ),
          )
          .returning({
            id: workspaceViewTemplates.id,
            name: workspaceViewTemplates.name,
          });

        const deletedTemplate = deleted.at(0);
        if (!deletedTemplate) {
          return;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW_TEMPLATE,
          resourceId: deletedTemplate.id,
          changes: {
            deleted: {
              old: { name: deletedTemplate.name },
              new: null,
            },
          },
        });
      }),
    );

    return Result.ok({});
  },
);

export default deleteViewTemplate;
