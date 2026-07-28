import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { sharepointConnections } from "@/api/db/schema";
import { assertSharepointConnectionEnabled } from "@/api/handlers/sharepoint/enablement";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

// Read the current user's connection state for the active org. Never returns
// token material — only status, granted scope, and display metadata.
const sharepointConnectionStatus = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    yield* Result.await(
      assertSharepointConnectionEnabled({
        organizationId: session.activeOrganizationId,
        safeDb,
      }),
    );

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: sharepointConnections.id,
            status: sharepointConnections.status,
            scope: sharepointConnections.scope,
            accountLabel: sharepointConnections.accountLabel,
            expiresAt: sharepointConnections.expiresAt,
            lastUsedAt: sharepointConnections.lastUsedAt,
            createdAt: sharepointConnections.createdAt,
          })
          .from(sharepointConnections)
          .where(
            and(
              eq(
                sharepointConnections.organizationId,
                session.activeOrganizationId,
              ),
              eq(sharepointConnections.userId, user.id),
            ),
          )
          .limit(1),
      ),
    );

    return Result.ok({ connection: rows.at(0) ?? null });
  },
);

export default sharepointConnectionStatus;
