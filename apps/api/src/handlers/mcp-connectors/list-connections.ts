import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { mcpConnectors, mcpUserConnections } from "@/api/db/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listMcpConnections = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const connections = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: mcpUserConnections.id,
            connectorId: mcpUserConnections.connectorId,
            connectorSlug: mcpConnectors.slug,
            status: mcpUserConnections.status,
            enabled: mcpUserConnections.enabled,
            scope: mcpUserConnections.scope,
            expiresAt: mcpUserConnections.expiresAt,
            lastUsedAt: mcpUserConnections.lastUsedAt,
            createdAt: mcpUserConnections.createdAt,
            updatedAt: mcpUserConnections.updatedAt,
          })
          .from(mcpUserConnections)
          .innerJoin(
            mcpConnectors,
            eq(mcpConnectors.id, mcpUserConnections.connectorId),
          )
          .where(
            and(
              eq(
                mcpUserConnections.organizationId,
                session.activeOrganizationId,
              ),
              eq(mcpUserConnections.userId, user.id),
            ),
          )
          .limit(100),
      ),
    );

    return Result.ok({ connections });
  },
);

export default listMcpConnections;
