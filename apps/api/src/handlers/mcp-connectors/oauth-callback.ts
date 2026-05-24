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
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
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

type CallbackRedirectInput =
  | { status: "connected"; slug: string }
  | { status: "error"; reason: string };

// The popup lands on a SPA route that does the postMessage + close.
// Returning HTML with an inline <script> from api.stll.app is blocked
// by the API's CSP (`script-src 'self' 'unsafe-eval'`) and its
// `Cross-Origin-Opener-Policy: same-origin` would also detach
// `window.opener`, so the SPA host is the only place the terminal
// page can run.
export const buildCallbackRedirectUrl = (
  frontendUrl: string,
  input: CallbackRedirectInput,
): string => {
  const url = new URL("/mcp/oauth-callback", frontendUrl);
  url.searchParams.set("status", input.status);
  if (input.status === "connected") {
    url.searchParams.set("slug", input.slug);
  } else {
    url.searchParams.set("reason", input.reason);
  }
  return url.toString();
};

const redirect = (input: CallbackRedirectInput) =>
  new Response(null, {
    status: 302,
    headers: { Location: buildCallbackRedirectUrl(env.FRONTEND_URL, input) },
  });

const mcpOAuthCallback = createSafeRootHandler(
  config,
  async function* ({ query: input, safeDb, session, user, recordAuditEvent }) {
    if (!input.code || !input.state) {
      return Result.ok(redirect({ status: "error", reason: "missing-code" }));
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
          redirect({ status: "error", reason: "expired-state" }),
        );
      }
      if (!row.connector) {
        return Result.ok(
          redirect({ status: "error", reason: "missing-connector" }),
        );
      }
      if (
        row.organizationId !== session.activeOrganizationId ||
        row.userId !== user.id
      ) {
        return Result.ok(
          redirect({ status: "error", reason: "user-mismatch" }),
        );
      }
      const connectorSlug = row.connector.slug;

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
          redirect({ status: "error", reason: "missing-client" }),
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
          redirect({ status: "error", reason: "token-exchange" }),
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
              await recordAuditEvent(innerTx, {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
                resourceId: row.connectorId,
                workspaceId: null,
                metadata: {
                  connectorId: row.connectorId,
                  connectorSlug,
                  connectionUserId: rowUserId,
                  operation: "mcp_oauth_connect",
                },
              });
            }),
        ),
      );

      return Result.ok(redirect({ status: "connected", slug: connectorSlug }));
    } catch (error) {
      if (HandlerError.is(error)) {
        return Result.ok(
          redirect({ status: "error", reason: "invalid-secret" }),
        );
      }

      return Result.ok(redirect({ status: "error", reason: "unexpected" }));
    }
  },
);

export default mcpOAuthCallback;
