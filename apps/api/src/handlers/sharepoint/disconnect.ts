import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { sharepointConnections } from "@/api/db/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

// Remove the current user's connection (and its encrypted tokens) for the
// active org. Idempotent: reports whether a row was deleted.
//
// Deliberately NOT gated on org enablement: credential removal must always be
// possible, even after the feature is disabled, so a user can always revoke
// their own stored tokens. Auth plus org/user ownership still apply.
const disconnectSharepoint = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, recordAuditEvent }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(sharepointConnections)
          .where(
            and(
              eq(
                sharepointConnections.organizationId,
                session.activeOrganizationId,
              ),
              eq(sharepointConnections.userId, user.id),
            ),
          )
          .returning({ id: sharepointConnections.id });

        // A stored delegated-token connection is a per-user credential; its
        // removal is a distinct credential-lifecycle event, recorded in the
        // same transaction as the delete. No-op deletes record nothing.
        if (rows.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: session.activeOrganizationId,
            workspaceId: null,
            metadata: {
              connectionUserId: user.id,
              operation: "sharepoint_oauth_disconnect",
              scope: "self",
            },
          });
        }

        return rows;
      }),
    );

    return Result.ok({ disconnected: deleted.length > 0 });
  },
);

export default disconnectSharepoint;
