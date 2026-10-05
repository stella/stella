import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaceViewTemplates } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  AVT_LAYOUT_FEATURE_ACCESS,
  avtViewAccessStatus,
  isAvtLayoutVisible,
} from "@/api/lib/auth/feature-access/view-eligibility";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  featureAccess: AVT_LAYOUT_FEATURE_ACCESS,
  description:
    "Delete one of your own saved view templates, the personal blueprint used " +
    "to create new views. Views already created from it are untouched, and the " +
    "call succeeds silently when the template does not exist or belongs to " +
    "someone else.",
  permissions: { view: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: workspaceParams({
    templateId: tSafeId("workspaceViewTemplate"),
  }),
} satisfies WorkspaceHandlerConfig;

const deleteViewTemplate = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    params,
    recordAuditEvent,
    featureAccessSnapshot,
  }) {
    const template = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaceViewTemplates.findFirst({
          where: {
            id: { eq: params.templateId },
            organizationId: { eq: session.activeOrganizationId },
            userId: { eq: user.id },
          },
          columns: { layout: true },
        }),
      ),
    );
    if (
      template !== undefined &&
      !isAvtLayoutVisible(
        template.layout,
        avtViewAccessStatus({
          snapshot: featureAccessSnapshot,
          organizationId: session.activeOrganizationId,
          userId: user.id,
        }),
      )
    ) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }
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
