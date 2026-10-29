import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { MICROSOFT365_CAPABILITIES } from "@stll/api-contract/microsoft365";

import { sharepointConnections } from "@/api/db/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  capabilityEnabled,
  grantedCapabilities,
} from "@/api/lib/auth/microsoft365/capabilities";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "provider_secret" },
  access: "read",
} satisfies HandlerConfig;

// Read the current user's connection state for the active org. Never returns
// token material — only status, granted scope, and display metadata.
const sharepointConnectionStatus = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    if (!isDeploymentFeatureEnabled("FEATURE_SHAREPOINT")) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }

    const policy = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            sharepointConnectionEnabled: true,
            microsoft365CalendarReadEnabled: true,
          },
        }),
      ),
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

    const connection = rows.at(0);
    const currentPolicy = policy ?? {
      sharepointConnectionEnabled: false,
      microsoft365CalendarReadEnabled: false,
    };
    return Result.ok({
      policy: currentPolicy,
      enabledCapabilities: MICROSOFT365_CAPABILITIES.filter((capability) =>
        capabilityEnabled(currentPolicy, capability),
      ),
      connection: connection
        ? {
            ...connection,
            // A legacy row without stored provider scopes cannot prove any
            // capability, even if its pre-migration status was connected.
            status:
              connection.scope === null
                ? ("reconnect_required" as const)
                : connection.status,
            capabilities: grantedCapabilities(connection.scope),
          }
        : null,
    });
  },
);

export default sharepointConnectionStatus;
