import { Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import { mcpConnectors, mcpUserConnections } from "@/api/db/schema";
import { encryptMcpSecret } from "@/api/handlers/mcp-connectors/crypto";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const requestBody = t.Object({
  connectorSlug: t.String({ minLength: 1, maxLength: 80 }),
  token: t.String({ minLength: 1, maxLength: 4096 }),
});

const config = {
  permissions: { workspace: ["read"] },
  body: requestBody,
} satisfies HandlerConfig;

const createMcpConnection = createSafeRootHandler(
  config,
  async function* ({ body: input, safeDb, session, user }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: mcpConnectors.id,
            authType: mcpConnectors.authType,
          })
          .from(mcpConnectors)
          .where(
            and(
              eq(mcpConnectors.slug, input.connectorSlug),
              or(
                isNull(mcpConnectors.organizationId),
                eq(mcpConnectors.organizationId, session.activeOrganizationId),
              ),
            ),
          )
          .limit(1),
      ),
    );

    const connector = rows.at(0);
    if (!connector) {
      return Result.err(
        new HandlerError({ status: 404, message: "MCP connector not found" }),
      );
    }

    if (connector.authType !== "bearer") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "MCP connector does not accept a static token",
        }),
      );
    }

    const encrypted = await encryptMcpSecret({
      connectorId: connector.id,
      organizationId: session.activeOrganizationId,
      purpose: "mcp_static_token",
      secret: input.token.trim(),
      userId: user.id,
    });

    const saved = yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(mcpUserConnections)
          .values({
            organizationId: session.activeOrganizationId,
            connectorId: connector.id,
            userId: user.id,
            staticTokenEncrypted: encrypted.ciphertext,
            staticTokenIv: encrypted.iv,
            status: "connected",
            enabled: true,
            tokenType: "Bearer",
          })
          .onConflictDoUpdate({
            target: [
              mcpUserConnections.organizationId,
              mcpUserConnections.connectorId,
              mcpUserConnections.userId,
            ],
            set: {
              accessTokenEncrypted: null,
              accessTokenIv: null,
              expiresAt: null,
              refreshTokenEncrypted: null,
              refreshTokenIv: null,
              resourceUrl: null,
              authorizationServerUrl: null,
              scope: null,
              staticTokenEncrypted: encrypted.ciphertext,
              staticTokenIv: encrypted.iv,
              status: "connected",
              enabled: true,
              tokenType: "Bearer",
              updatedAt: new Date(),
            },
          })
          .returning({
            id: mcpUserConnections.id,
            status: mcpUserConnections.status,
          }),
      ),
    );

    const connection = saved.at(0);
    if (!connection) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to save MCP connection",
        }),
      );
    }

    return Result.ok(connection);
  },
);

export default createMcpConnection;
