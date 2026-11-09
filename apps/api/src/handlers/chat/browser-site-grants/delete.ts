import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { chatBrowserSiteGrants } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: v.object({ grantId: resourceIdSchema("chatBrowserSiteGrant") }),
} satisfies HandlerConfig;

/** Remove one of the user's website approvals. Idempotent. */
const deleteBrowserSiteGrant = createSafeRootHandler(
  config,
  async function* ({
    params: { grantId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        await withAggregateLock({
          tx,
          aggregate: "chatToolGrants",
          id: { organizationId: session.activeOrganizationId, userId: user.id },
        });
        const rows = await tx
          .delete(chatBrowserSiteGrants)
          .where(
            and(
              eq(chatBrowserSiteGrants.id, grantId),
              eq(
                chatBrowserSiteGrants.organizationId,
                session.activeOrganizationId,
              ),
              eq(chatBrowserSiteGrants.userId, user.id),
            ),
          )
          .returning({
            id: chatBrowserSiteGrants.id,
            origin: chatBrowserSiteGrants.origin,
          });
        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_TOOL_GRANT,
            resourceId: row.id,
            workspaceId: null,
            metadata: { browserOrigin: row.origin, scope: "always" },
          });
        }
        return rows;
      }),
    );
    return Result.ok({ deleted: deleted.length > 0 });
  },
);

declareAggregateMutation(deleteBrowserSiteGrant, {
  type: "aggregate",
  aggregates: ["chatToolGrants"],
});

export default deleteBrowserSiteGrant;
