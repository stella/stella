import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { microsoft365Connections } from "@/api/db/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { grantedCapabilities } from "./capabilities";

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "provider_secret" },
  access: "read",
} satisfies HandlerConfig;

// Read the current user's connection state for the active org. Never returns
// token material — only status, granted scope, and display metadata.
const microsoft365ConnectionStatus = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    if (!isDeploymentFeatureEnabled("FEATURE_MICROSOFT365")) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }
    const policy = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            microsoft365ConnectionEnabled: true,
            microsoft365FilesReadEnabled: true,
            microsoft365CalendarReadEnabled: true,
          },
        }),
      ),
    );

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: microsoft365Connections.id,
            status: microsoft365Connections.status,
            scope: microsoft365Connections.scope,
            accountLabel: microsoft365Connections.accountLabel,
            expiresAt: microsoft365Connections.expiresAt,
            lastUsedAt: microsoft365Connections.lastUsedAt,
            createdAt: microsoft365Connections.createdAt,
          })
          .from(microsoft365Connections)
          .where(
            and(
              eq(
                microsoft365Connections.organizationId,
                session.activeOrganizationId,
              ),
              eq(microsoft365Connections.userId, user.id),
            ),
          )
          .limit(1),
      ),
    );

    const connection = rows.at(0);
    return Result.ok({
      policy: policy ?? {
        microsoft365ConnectionEnabled: false,
        microsoft365FilesReadEnabled: false,
        microsoft365CalendarReadEnabled: false,
      },
      connection: connection
        ? { ...connection, capabilities: grantedCapabilities(connection.scope) }
        : null,
    });
  },
);

export default microsoft365ConnectionStatus;
