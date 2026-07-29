import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";

import { shareRecipients, shareSpaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { shareSpace: ["revoke"] },
  mcp: { type: "capability", reason: "external_sharing" },
  access: "write",
  params: workspaceParams({ shareSpaceId: tSafeId("shareSpace") }),
} satisfies HandlerConfig;

const createShareSpaceRevocation = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.shareSpaces.findFirst({
          where: {
            id: { eq: params.shareSpaceId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true, status: true, revokedAt: true },
        });
        if (!existing) {
          return null;
        }
        if (existing.status === "revoked") {
          return { status: "revoked" as const, revokedAt: existing.revokedAt };
        }

        const revokedAt = new Date();
        await tx
          .update(shareSpaces)
          .set({ status: "revoked", revokedAt })
          .where(
            and(
              eq(shareSpaces.id, params.shareSpaceId),
              eq(shareSpaces.workspaceId, workspaceId),
              ne(shareSpaces.status, "revoked"),
            ),
          );
        await tx
          .update(shareRecipients)
          .set({ status: "revoked", revokedAt })
          .where(
            and(
              eq(shareRecipients.shareSpaceId, params.shareSpaceId),
              ne(shareRecipients.status, "revoked"),
            ),
          );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SHARE_SPACE,
          resourceId: params.shareSpaceId,
          changes: { status: { old: existing.status, new: "revoked" } },
          metadata: { event: "share_revoked" },
        });
        return { status: "revoked" as const, revokedAt };
      }),
    );
    if (!outcome) {
      return Result.err(
        new HandlerError({ status: 404, message: "Share Space not found." }),
      );
    }
    return Result.ok({
      status: outcome.status,
      revokedAt: outcome.revokedAt?.toISOString() ?? null,
    });
  },
);

export default createShareSpaceRevocation;
