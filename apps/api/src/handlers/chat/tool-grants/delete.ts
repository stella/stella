import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { chatToolGrants } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: t.Object({ grantId: tSafeId("chatToolGrant") }),
} satisfies HandlerConfig;

/** Remove one of the user's stored approvals. Idempotent. */
const deleteChatToolGrant = createSafeRootHandler(
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
        const rows = await tx
          .delete(chatToolGrants)
          .where(
            and(
              eq(chatToolGrants.id, grantId),
              eq(chatToolGrants.organizationId, session.activeOrganizationId),
              eq(chatToolGrants.userId, user.id),
            ),
          )
          .returning({
            id: chatToolGrants.id,
            scope: chatToolGrants.scope,
            toolName: chatToolGrants.toolName,
            mcpConnectorId: chatToolGrants.mcpConnectorId,
          });
        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_TOOL_GRANT,
            resourceId: row.id,
            workspaceId: null,
            metadata: {
              mcpConnectorId: row.mcpConnectorId,
              scope: row.scope,
              toolName: row.toolName,
            },
          });
        }
        return rows;
      }),
    );
    return Result.ok({ deleted: deleted.length > 0 });
  },
);

export default deleteChatToolGrant;
