import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { mcpUserConnections } from "@/api/db/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const routeParams = t.Object({
  connectionId: tSafeId("mcpUserConnection"),
});

const requestBody = t.Object({
  enabled: t.Boolean(),
});

const config = {
  permissions: { workspace: ["read"] },
  params: routeParams,
  body: requestBody,
} satisfies HandlerConfig;

const updateMcpConnection = createSafeRootHandler(
  config,
  async function* ({ body, params: requestParams, safeDb, session, user }) {
    const updated = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — per-user MCP connection enable/disable toggle; the connector itself is SOC 2-audited at create-connector / delete-connector.
        return tx
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
            enabled: mcpUserConnections.enabled,
            status: mcpUserConnections.status,
          });
      }),
    );

    const connection = updated.at(0);
    if (!connection) {
      return Result.err(
        new HandlerError({ status: 404, message: "MCP connection not found" }),
      );
    }

    return Result.ok(connection);
  },
);

export default updateMcpConnection;
