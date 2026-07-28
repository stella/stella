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

// Remove the current user's connection (and its encrypted tokens) for the
// active org. Idempotent: reports whether a row was deleted.
const disconnectSharepoint = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    yield* Result.await(
      assertSharepointConnectionEnabled({
        organizationId: session.activeOrganizationId,
        safeDb,
      }),
    );

    const deleted = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — per-user connection removal; the org-level enablement toggle is the SOC 2-audited surface.
        return tx
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
      }),
    );

    return Result.ok({ disconnected: deleted.length > 0 });
  },
);

export default disconnectSharepoint;
