import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { matterInboundAddresses, workspaces } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateInboundAddressToken } from "@/api/lib/inbound-mail/address";

const config = {
  description:
    "Rotate a matter's inbound address; the previous address stops accepting mail immediately.",
  permissions: { workspace: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies WorkspaceHandlerConfig;

const createMatterInboundAddress = createSafeHandler(
  config,
  async function* ({ safeDb, session, user, workspaceId, recordAuditEvent }) {
    if (env.INBOUND_MAIL_DOMAIN === undefined) {
      return Result.err(
        new HandlerError({
          status: 503,
          message: "Inbound mail domain is not configured",
        }),
      );
    }
    const token = generateInboundAddressToken();
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .for("update");
        const now = new Date();
        await tx
          .update(matterInboundAddresses)
          .set({ revokedAt: now, revokedBy: user.id })
          .where(
            and(
              eq(matterInboundAddresses.workspaceId, workspaceId),
              isNull(matterInboundAddresses.revokedAt),
            ),
          );
        await tx.insert(matterInboundAddresses).values({
          organizationId: session.activeOrganizationId,
          workspaceId,
          token,
          createdBy: user.id,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: workspaceId,
          changes: { inboundAddress: { old: "active", new: "rotated" } },
        });
      }),
    );
    return Result.ok({ address: `${token}@${env.INBOUND_MAIL_DOMAIN}` });
  },
);

export default createMatterInboundAddress;
