import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { matterInboundAddresses, workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const config = {
  description: "Revoke the active inbound address for a matter.",
  permissions: { workspace: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies WorkspaceHandlerConfig;

const deleteMatterInboundAddress = createSafeHandler(
  config,
  async function* ({ safeDb, user, workspaceId, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .for("update");
        const revoked = await tx
          .update(matterInboundAddresses)
          .set({ revokedAt: new Date(), revokedBy: user.id })
          .where(
            and(
              eq(matterInboundAddresses.workspaceId, workspaceId),
              isNull(matterInboundAddresses.revokedAt),
            ),
          )
          .returning({ id: matterInboundAddresses.id });
        if (revoked.length > 0)
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: { inboundAddress: { old: "active", new: "revoked" } },
          });
      }),
    );
    return Result.ok({ address: null });
  },
);

export default deleteMatterInboundAddress;
