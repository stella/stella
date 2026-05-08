import { Result } from "better-result";
import { eq, lt } from "drizzle-orm";
import { t } from "elysia";

import { mcpOAuthState, mcpUserConnections } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  decryptMcpSecret,
  encryptMcpSecret,
} from "@/api/handlers/mcp-connectors/crypto";
import {
  exchangeAuthorizationCode,
  tokenExpiresAt,
} from "@/api/handlers/mcp-connectors/oauth";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const STATE_TTL_MS = 10 * 60 * 1000;

const requestQuery = t.Object({
  code: t.Optional(t.String()),
  state: t.Optional(t.String()),
});

const config = {
  permissions: { workspace: ["read"] },
  query: requestQuery,
} satisfies HandlerConfig;

const htmlResponse = (body: string, status = 200) =>
  new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status,
  });

const mcpSettingsUrl = () =>
  new URL("/knowledge/mcp", env.FRONTEND_URL).toString();

const callbackHtml = (message: string) => `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>MCP connection</title></head>
  <body>
    <script>
      if (window.opener) {
        window.opener.postMessage(${JSON.stringify(message)}, ${JSON.stringify(
          env.FRONTEND_URL,
        )});
        window.close();
      } else {
        window.location.replace(${JSON.stringify(mcpSettingsUrl())});
      }
    </script>
  </body>
</html>`;

const mcpOAuthCallback = createSafeRootHandler(
  config,
  async function* ({ query: input, safeDb, session, user }) {
    if (!input.code || !input.state) {
      return Result.ok(
        htmlResponse(callbackHtml("mcp:error:missing-code"), 400),
      );
    }
    const code = input.code;
    const state = input.state;

    const cutoff = new Date(Date.now() - STATE_TTL_MS);

    try {
      const row = yield* Result.await(
        safeDb((tx) =>
          tx.query.mcpOAuthState.findFirst({
            where: { state: { eq: state } },
            with: {
              connector: {
                columns: {
                  id: true,
                  slug: true,
                },
              },
            },
          }),
        ),
      );

      if (!row || row.createdAt < cutoff) {
        return Result.ok(
          htmlResponse(callbackHtml("mcp:error:expired-state"), 400),
        );
      }
      if (!row.connector) {
        return Result.ok(
          htmlResponse(callbackHtml("mcp:error:missing-connector"), 400),
        );
      }
      if (
        row.organizationId !== session.activeOrganizationId ||
        row.userId !== user.id
      ) {
        return Result.ok(
          htmlResponse(callbackHtml("mcp:error:user-mismatch"), 403),
        );
      }

      const client = yield* Result.await(
        safeDb((tx) =>
          tx.query.mcpOAuthClients.findFirst({
            where: {
              organizationId: { eq: row.organizationId },
              connectorId: { eq: row.connectorId },
              authorizationServerUrl: { eq: row.authorizationServerUrl },
            },
            columns: {
              clientId: true,
              clientSecretEncrypted: true,
              clientSecretIv: true,
            },
          }),
        ),
      );

      if (!client) {
        return Result.ok(
          htmlResponse(callbackHtml("mcp:error:missing-client"), 400),
        );
      }

      const clientSecret =
        client.clientSecretEncrypted && client.clientSecretIv
          ? await decryptMcpSecret({
              ciphertext: client.clientSecretEncrypted,
              connectorId: row.connectorId,
              iv: client.clientSecretIv,
              organizationId: row.organizationId,
              purpose: "mcp_client_secret",
            })
          : null;

      const token = await exchangeAuthorizationCode({
        authorizationServerUrl: row.authorizationServerUrl,
        clientId: client.clientId,
        clientSecret,
        code,
        codeVerifier: row.codeVerifier,
        redirectUri: row.redirectUri,
        resourceUrl: row.resourceUrl,
      });

      if (Result.isError(token)) {
        return Result.ok(
          htmlResponse(callbackHtml("mcp:error:token-exchange"), 400),
        );
      }

      const rowUserId = brandPersistedUserId(row.userId);
      const encryptedAccess = await encryptMcpSecret({
        connectorId: row.connectorId,
        organizationId: row.organizationId,
        purpose: "mcp_access_token",
        secret: token.value.access_token,
        userId: rowUserId,
      });
      const encryptedRefresh = token.value.refresh_token
        ? await encryptMcpSecret({
            connectorId: row.connectorId,
            organizationId: row.organizationId,
            purpose: "mcp_refresh_token",
            secret: token.value.refresh_token,
            userId: rowUserId,
          })
        : null;

      yield* Result.await(
        safeDb(
          async (tx) =>
            await tx.transaction(async (innerTx) => {
              await innerTx
                .delete(mcpOAuthState)
                .where(eq(mcpOAuthState.state, state));
              await innerTx
                .delete(mcpOAuthState)
                .where(lt(mcpOAuthState.createdAt, cutoff));
              await innerTx
                .insert(mcpUserConnections)
                .values({
                  organizationId: row.organizationId,
                  connectorId: row.connectorId,
                  userId: rowUserId,
                  accessTokenEncrypted: encryptedAccess.ciphertext,
                  accessTokenIv: encryptedAccess.iv,
                  refreshTokenEncrypted: encryptedRefresh?.ciphertext ?? null,
                  refreshTokenIv: encryptedRefresh?.iv ?? null,
                  tokenType: token.value.token_type ?? "Bearer",
                  scope: token.value.scope ?? null,
                  resourceUrl: row.resourceUrl,
                  authorizationServerUrl: row.authorizationServerUrl,
                  expiresAt: tokenExpiresAt(token.value),
                  status: "connected",
                  enabled: true,
                })
                .onConflictDoUpdate({
                  target: [
                    mcpUserConnections.organizationId,
                    mcpUserConnections.connectorId,
                    mcpUserConnections.userId,
                  ],
                  set: {
                    accessTokenEncrypted: encryptedAccess.ciphertext,
                    accessTokenIv: encryptedAccess.iv,
                    refreshTokenEncrypted: encryptedRefresh?.ciphertext ?? null,
                    refreshTokenIv: encryptedRefresh?.iv ?? null,
                    staticTokenEncrypted: null,
                    staticTokenIv: null,
                    tokenType: token.value.token_type ?? "Bearer",
                    scope: token.value.scope ?? null,
                    resourceUrl: row.resourceUrl,
                    authorizationServerUrl: row.authorizationServerUrl,
                    expiresAt: tokenExpiresAt(token.value),
                    status: "connected",
                    enabled: true,
                    updatedAt: new Date(),
                  },
                });
            }),
        ),
      );

      return Result.ok(
        htmlResponse(callbackHtml(`mcp:connected:${row.connector.slug}`)),
      );
    } catch (error) {
      if (HandlerError.is(error)) {
        return Result.ok(
          htmlResponse(callbackHtml("mcp:error:invalid-secret"), 400),
        );
      }

      return Result.ok(htmlResponse(callbackHtml("mcp:error:unexpected"), 500));
    }
  },
);

export default mcpOAuthCallback;
