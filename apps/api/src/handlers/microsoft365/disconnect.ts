import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  microsoft365Connections,
  microsoft365OAuthState,
} from "@/api/db/schema";
import { microsoft365RealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

const config = {
  contract: "patch",
  permissions: { integration: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: microsoft365RealtimeUpdates,
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

// Remove the current user's connection (and its encrypted tokens) for the
// active org. Idempotent: reports whether a row was deleted.
//
// Deliberately NOT gated on org enablement: credential removal must always be
// possible, even after the feature is disabled, so a user can always revoke
// their own stored tokens. Auth plus org/user ownership still apply.
const disconnectMicrosoft365 = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, recordAuditEvent }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        await withAggregateLock({
          tx,
          aggregate: "organization",
          id: session.activeOrganizationId,
          mode: "update",
        });
        // audit: skip — invalidate ephemeral consent attempts with credential removal.
        await tx
          .delete(microsoft365OAuthState)
          .where(
            and(
              eq(
                microsoft365OAuthState.organizationId,
                session.activeOrganizationId,
              ),
              eq(microsoft365OAuthState.userId, user.id),
            ),
          );
        const rows = await tx
          .delete(microsoft365Connections)
          .where(
            and(
              eq(
                microsoft365Connections.organizationId,
                session.activeOrganizationId,
              ),
              eq(microsoft365Connections.userId, user.id),
            ),
          )
          .returning({ id: microsoft365Connections.id });

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
              operation: "microsoft365_oauth_disconnect",
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

export default disconnectMicrosoft365;
