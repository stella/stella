import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { mcpUserConnections } from "@/api/db/schema";
import { mcpConnectorRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { detached } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  DELETED_MCP_CONNECTION_CREDENTIAL_FIELDS,
  revocableMcpConnectionFromDeleted,
} from "@/api/lib/mcp-upstream/connections";
import { revokeMcpConnectionTokens } from "@/api/lib/mcp-upstream/revocation";
import type { McpTokenRevocationOutcome } from "@/api/lib/mcp-upstream/revocation";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const routeParams = v.object({
  connectionId: resourceIdSchema("mcpUserConnection"),
});

const config = {
  contract: "patch",
  permissions: { integration: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: mcpConnectorRealtimeUpdates,
  mcp: { type: "internal", reason: "mcp_transport" },
  params: routeParams,
} satisfies HandlerConfig;

const REVOCATION_FAILED = failureSink({
  event: "mcp_upstream.token_revocation_failed",
  expected: [],
});

const reportRevocationOutcome = (outcome: McpTokenRevocationOutcome): void => {
  if (outcome.type === "discovery_failed") {
    observeFailure(outcome.error, {
      sink: REVOCATION_FAILED,
      ctx: { source: "mcp-connection-revocation", phase: "discovery" },
    });
    return;
  }
  if (outcome.type !== "attempted") {
    return;
  }
  for (const failure of outcome.failed) {
    observeFailure(failure.error, {
      sink: REVOCATION_FAILED,
      ctx: { source: "mcp-connection-revocation", phase: failure.tokenType },
    });
  }
};

export type DeleteMcpConnectionDependencies = {
  revocableMcpConnectionFromDeleted: typeof revocableMcpConnectionFromDeleted;
  revokeMcpConnectionTokens: typeof revokeMcpConnectionTokens;
};

const defaultDeleteMcpConnectionDependencies = {
  revocableMcpConnectionFromDeleted,
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
            // The delete returns the credentials it removed, so revocation
            // uses exactly those, even if a reconnect raced the disconnect.
            .returning(DELETED_MCP_CONNECTION_CREDENTIAL_FIELDS);
          const row = rows.at(0);
          if (row) {
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.DELETE,
              resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
              resourceId: row.userConnectionId,
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
      const revokeDeletedTokens = async (): Promise<void> => {
        const resolved = await dependencies.revocableMcpConnectionFromDeleted({
          deleted: connection,
          organizationId: session.activeOrganizationId,
          safeDb,
        });
        if (Result.isError(resolved)) {
          observeFailure(resolved.error, {
            sink: REVOCATION_FAILED,
            ctx: { source: "mcp-connection-revocation", phase: "resolve" },
          });
          return;
        }
        const revocable = resolved.value;
        if (revocable === null) {
          return;
        }
        reportRevocationOutcome(
          await dependencies.revokeMcpConnectionTokens({
            connection: revocable,
            organizationId: session.activeOrganizationId,
            permit: grantThirdPartyOutboundPermit(),
            userId: user.id,
          }),
        );
      };
      detached(revokeDeletedTokens(), "mcp-connection.revoke-tokens");

      return Result.ok({ id: connection.userConnectionId });
    },
  );

export default createDeleteMcpConnectionHandler(
  defaultDeleteMcpConnectionDependencies,
);
