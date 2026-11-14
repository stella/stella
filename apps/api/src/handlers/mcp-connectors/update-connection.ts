import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { mcpUserConnections } from "@/api/db/schema";
import { mcpConnectorRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const routeParams = v.object({
  connectionId: resourceIdSchema("mcpUserConnection"),
});

const requestBody = v.object({ enabled: v.boolean() });

const config = {
  contract: "patch",
  permissions: { integration: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: mcpConnectorRealtimeUpdates,
  mcp: { type: "internal", reason: "mcp_transport" },
  params: routeParams,
  body: requestBody,
} satisfies HandlerConfig;

const updateMcpConnection = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: requestParams,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .update(mcpUserConnections)
          .set({
            enabled: body.enabled,
            updatedAt: new Date(),
          })
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
            enabled: mcpUserConnections.enabled,
            status: mcpUserConnections.status,
          });
        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
            resourceId: row.id,
            workspaceId: null,
            metadata: {
              connectorId: row.connectorId,
              enabled: row.enabled,
              operation: "set_enabled",
            },
          });
        }
        return rows;
      }),
    );

    const connection = updated.at(0);
    if (!connection) {
      return Result.err(
        new HandlerError({ status: 404, message: "MCP connection not found" }),
      );
    }

    return Result.ok({
      id: connection.id,
      enabled: connection.enabled,
      status: connection.status,
    });
  },
);

export default updateMcpConnection;
