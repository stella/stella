import { Result } from "better-result";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import { decryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import {
  discoverOAuthMetadata,
  oauthRevocationEndpoint,
  revokeOAuthToken,
} from "@/api/lib/mcp-upstream/oauth";
import { validateOutboundFetchTarget } from "@/api/lib/safe-outbound-fetch";

// One budget for discovery plus both revocation calls. Revocation runs after
// the local disconnect committed, so it only bounds outbound work.
const MCP_REVOCATION_BUDGET_MS = 15_000;
const MCP_REVOCATION_REQUEST_TIMEOUT_MS = 5000;

export type McpTokenRevocationDependencies = {
  decryptMcpSecret: typeof decryptMcpSecret;
  discoverOAuthMetadata: typeof discoverOAuthMetadata;
  revokeOAuthToken: typeof revokeOAuthToken;
};

const defaultMcpTokenRevocationDependencies = {
  decryptMcpSecret,
  discoverOAuthMetadata,
  revokeOAuthToken,
} satisfies McpTokenRevocationDependencies;

type RevokedTokenType = "access_token" | "refresh_token";

export type McpTokenRevocationOutcome =
  | {
      type: "skipped";
      reason:
        | "issuer_mismatch"
        | "issuer_unapproved"
        | "no_revocation_endpoint"
        | "not_oauth";
    }
  | { type: "discovery_failed"; error: unknown }
  | {
      type: "attempted";
      revoked: RevokedTokenType[];
      failed: { tokenType: RevokedTokenType; error: unknown }[];
    };

/**
 * Ask the connector's authorization server to revoke a disconnected
 * connection's tokens (RFC 7009): the refresh token first, since revoking it
 * normally ends the grant, then the access token for servers that do not
 * cascade. Callers run this after the local delete committed; the outcome is
 * for telemetry and never decides whether the disconnect succeeded.
 */
export const revokeMcpConnectionTokens = async ({
  connection,
  dependencies = defaultMcpTokenRevocationDependencies,
  organizationId,
  permit,
  userId,
}: {
  connection: LoadedMcpConnection;
  dependencies?: McpTokenRevocationDependencies;
  organizationId: SafeId<"organization">;
  permit: ThirdPartyOutboundPermit;
  userId: SafeId<"user">;
}): Promise<McpTokenRevocationOutcome> => {
  if (connection.type !== "oauth2") {
    return { type: "skipped", reason: "not_oauth" };
  }
  const binding = connection.oauthIssuerBinding;
  if (binding.type !== "approved") {
    return { type: "skipped", reason: "issuer_unapproved" };
  }

  // Every request keeps the outbound guard (target validation, no
  // redirects, third-party permit) under one shared deadline.
  const outbound = {
    safeOutboundFetchBytes,
    signal: AbortSignal.timeout(MCP_REVOCATION_BUDGET_MS),
    timeoutMs: MCP_REVOCATION_REQUEST_TIMEOUT_MS,
    validateOutboundFetchTarget,
  };
  const metadata = await dependencies.discoverOAuthMetadata({
    rawMcpUrl: connection.url,
    permit,
    confirmedEndpointOrigins: binding.endpointOrigins,
    dependencies: outbound,
  });
  if (Result.isError(metadata)) {
    return { type: "discovery_failed", error: metadata.error };
  }
  const issuer = metadata.value.authorizationServer.issuer;
  // The tokens were issued by the server the connection recorded, under the
  // issuer the approval names; any drift means they are not this server's.
  if (
    issuer !== binding.issuer ||
    issuer !== connection.oauthAuthorizationServerUrl
  ) {
    return { type: "skipped", reason: "issuer_mismatch" };
  }
  const endpoint = oauthRevocationEndpoint({
    confirmedEndpointOrigins: binding.endpointOrigins,
    metadata: metadata.value,
  });
  if (endpoint === null) {
    return { type: "skipped", reason: "no_revocation_endpoint" };
  }

  const revoked: RevokedTokenType[] = [];
  const failed: { tokenType: RevokedTokenType; error: unknown }[] = [];
  const revoke = async (
    tokenTypeHint: RevokedTokenType,
    loadRevocable: () => Promise<
      Parameters<typeof revokeOAuthToken>[0]["revocable"]
    >,
  ) => {
    const result = await Result.tryPromise(async () => {
      const clientSecret =
        connection.oauthClientSecretEncrypted && connection.oauthClientSecretIv
          ? await dependencies.decryptMcpSecret({
              ciphertext: connection.oauthClientSecretEncrypted,
              connectorId: connection.connectorId,
              iv: connection.oauthClientSecretIv,
              organizationId,
              purpose: "mcp_client_secret",
            })
          : null;

      return await dependencies.revokeOAuthToken({
        clientId: connection.oauthClientId,
        clientSecret,
        dependencies: outbound,
        endpoint,
        permit,
        revocable: await loadRevocable(),
      });
    });
    if (Result.isError(result)) {
      failed.push({ tokenType: tokenTypeHint, error: result.error });
      return;
    }
    if (Result.isError(result.value)) {
      failed.push({
        tokenType: tokenTypeHint,
        error: result.value.error,
      });
      return;
    }
    revoked.push(tokenTypeHint);
  };

  const { refreshTokenEncrypted, refreshTokenIv } = connection;
  if (refreshTokenEncrypted && refreshTokenIv) {
    await revoke("refresh_token", async () => ({
      token: await dependencies.decryptMcpSecret({
        ciphertext: refreshTokenEncrypted,
        connectorId: connection.connectorId,
        iv: refreshTokenIv,
        organizationId,
        purpose: "mcp_refresh_token",
        userId,
      }),
      tokenTypeHint: "refresh_token",
    }));
  }
  await revoke("access_token", async () => ({
    token: await dependencies.decryptMcpSecret({
      ciphertext: connection.accessTokenEncrypted,
      connectorId: connection.connectorId,
      iv: connection.accessTokenIv,
      organizationId,
      purpose: "mcp_access_token",
      userId,
    }),
    tokenTypeHint: "access_token",
  }));

  return { type: "attempted", revoked, failed };
};
