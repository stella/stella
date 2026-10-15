import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { mcpUserConnections } from "@/api/db/schema";
import { mcpConnectorRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError, detached } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadMcpConnectionById } from "@/api/lib/mcp-upstream/connections";
import { revokeMcpConnectionTokens } from "@/api/lib/mcp-upstream/revocation";
import type { McpTokenRevocationOutcome } from "@/api/lib/mcp-upstream/revocation";

const routeParams = t.Object({
  connectionId: tSafeId("mcpUserConnection"),
});

const config = {
  contract: "patch",
  permissions: { integration: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: mcpConnectorRealtimeUpdates,
  mcp: { type: "internal", reason: "mcp_transport" },
  params: routeParams,
} satisfies HandlerConfig;

const reportRevocationOutcome =
  (connectorSlug: string) =>
  (outcome: McpTokenRevocationOutcome): void => {
    if (outcome.type === "discovery_failed") {
      captureError(outcome.error, {
        source: "mcp-connection-revocation",
        connectorSlug,
      });
      return;
    }
    if (outcome.type !== "attempted") {
      return;
    }
    for (const failure of outcome.failed) {
      captureError(failure.error, {
        source: "mcp-connection-revocation",
        connectorSlug,
        tokenType: failure.tokenType,
      });
    }
  };

export type DeleteMcpConnectionDependencies = {
  loadMcpConnectionById: typeof loadMcpConnectionById;
  revokeMcpConnectionTokens: typeof revokeMcpConnectionTokens;
};

const defaultDeleteMcpConnectionDependencies = {
  loadMcpConnectionById,
  revokeMcpConnectionTokens,
} satisfies DeleteMcpConnectionDependencies;

export const createDeleteMcpConnectionHandler = (
  dependencies: DeleteMcpConnectionDependencies,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      params: requestParams,
      recordAuditEvent,
      safeDb,
      session,
      user,
    }) {
      // Read the credentials before the row goes away; revocation needs them.
      const revocable = await dependencies.loadMcpConnectionById({
        connectionId: requestParams.connectionId,
        organizationId: session.activeOrganizationId,
        safeDb,
        userId: user.id,
      });

      const deleted = yield* Result.await(
        safeDb(async (tx) => {
          const rows = await tx
            .delete(mcpUserConnections)
            .where(
              and(
                eq(mcpUserConnections.id, requestParams.connectionId),
                eq(
                  mcpUserConnections.organizationId,
                  session.activeOrganizationId,
                ),
                eq(mcpUserConnections.userId, user.id),
              ),
            )
            .returning({
              id: mcpUserConnections.id,
              connectorId: mcpUserConnections.connectorId,
            });
          const row = rows.at(0);
          if (row) {
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.DELETE,
              resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
              resourceId: row.id,
              workspaceId: null,
              metadata: { connectorId: row.connectorId },
            });
          }
          return rows;
        }),
      );

      const connection = deleted.at(0);
      if (!connection) {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "MCP connection not found",
          }),
        );
      }

      // The local disconnect is final here. Upstream revocation is best effort,
      // runs outside the request, and only reports its failures.
      if (revocable !== null) {
        detached(
          dependencies
            .revokeMcpConnectionTokens({
              connection: revocable,
              organizationId: session.activeOrganizationId,
              permit: grantThirdPartyOutboundPermit(),
              userId: user.id,
            })
            .then(reportRevocationOutcome(revocable.slug)),
          "mcp-connection.revoke-tokens",
        );
      }

      return Result.ok({ id: connection.id });
    },
  );

export default createDeleteMcpConnectionHandler(
  defaultDeleteMcpConnectionDependencies,
);
