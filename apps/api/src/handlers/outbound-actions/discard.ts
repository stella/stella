import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { outboundActions } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  permissions: { integration: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "human_confirmation" },
  params: t.Object({ actionId: tSafeId("outboundAction") }),
} satisfies HandlerConfig;

/** Drop a pending action so it can never be confirmed. Idempotent. */
const discardOutboundAction = createSafeRootHandler(
  config,
  async function* ({
    params: { actionId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const discarded = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .update(outboundActions)
          .set({ status: "discarded", completedAt: new Date() })
          .where(
            and(
              eq(outboundActions.id, actionId),
              eq(outboundActions.organizationId, session.activeOrganizationId),
              eq(outboundActions.userId, user.id),
              eq(outboundActions.status, "pending"),
            ),
          )
          .returning({ kind: outboundActions.kind });
        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CANCEL,
            resourceType: AUDIT_RESOURCE_TYPE.OUTBOUND_ACTION,
            resourceId: actionId,
            workspaceId: null,
            metadata: { kind: row.kind, operation: "discard" },
          });
        }
        return rows;
      }),
    );
    return Result.ok({ discarded: discarded.length > 0 });
  },
);

export default discardOutboundAction;
