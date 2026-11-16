import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { legislationMatterLinks } from "@/api/db/schema";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { workspaceResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Unlink one statute provision from a matter without changing the legislation corpus.",
  permissions: { entity: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.WORKSPACE),
  mcp: {
    type: "capability",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  params: workspaceParams({
    linkId: resourceIdSchema("legislationMatterLink"),
  }),
} satisfies WorkspaceHandlerConfig;
const deleteLegislationMatterLink = createSafeHandler(
  config,
  async function* ({
    params: { linkId },
    recordAuditEvent,
    safeDb,
    session,
    workspaceId,
  }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        await withAggregateLock({
          tx,
          aggregate: "workspace",
          id: {
            id: workspaceId,
            organizationId: session.activeOrganizationId,
          },
          mode: "update",
        });
        const rows = await tx
          .delete(legislationMatterLinks)
          .where(
            and(
              eq(legislationMatterLinks.id, linkId),
              eq(legislationMatterLinks.workspaceId, workspaceId),
            ),
          )
          .returning({ id: legislationMatterLinks.id });
        if (rows.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.LEGISLATION_MATTER_LINK,
            resourceId: linkId,
            workspaceId,
          });
        }
        return rows;
      }),
    );
    return Result.ok(
      deleted.length === 0
        ? status(404, {
            code: "LEGISLATION_MATTER_LINK_NOT_FOUND",
            message: "Matter link not found",
          })
        : { success: true },
    );
  },
);

declareAggregateMutation(deleteLegislationMatterLink, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default deleteLegislationMatterLink;
