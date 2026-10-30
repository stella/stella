import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { legislationMatterLinks } from "@/api/db/schema";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  description:
    "Unlink one statute provision from a matter without changing the legislation corpus.",
  permissions: { entity: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  params: workspaceParams({
    linkId: resourceIdSchema("legislationMatterLink"),
  }),
} satisfies WorkspaceHandlerConfig;
export default createSafeHandler(
  config,
  async function* ({
    params: { linkId },
    recordAuditEvent,
    scopedDb,
    workspaceId,
  }) {
    const deleted = yield* Result.await(
      Result.tryPromise(
        async () =>
          await scopedDb(async (tx) => {
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
      ),
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
