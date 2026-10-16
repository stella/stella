import { Result } from "better-result";
/**
 * Delegated Microsoft Graph OAuth for the Microsoft 365 / OneDrive connection.
 *
 * Unlike the MCP connector flow (arbitrary authorization servers, dynamic
 * discovery + registration), Microsoft's identity platform is a fixed,
 * first-party authorization server. We reuse the deployment's existing
 * Microsoft app registration (MICROSOFT_AUTH_CLIENT_ID/_SECRET/_TENANT_ID)
 * and derive the tenant-scoped v2.0 endpoints directly — no discovery, no
 * SSRF surface (the hosts are constants).
 *
 * Every requested scope is READ-ONLY and delegated (the user's own grant):
 * Microsoft enforces the ACLs on every downstream read, so the system never
 * mirrors a permission model. The read-only property is enforced at compile
 * time (see `readOnlyScope`), not by discipline.
 */
import * as v from "valibot";

import { fetchWithTimeout } from "@stll/fetch";
import { sha256Base64Url as hashSha256Base64Url } from "@stll/sha256/bun";
import { readCappedBytes } from "@stll/skills/streaming";
import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { RefreshToken } from "@/api/lib/secret-brands";

import type { Microsoft365ReadScopes } from "./capabilities";

const GRAPH_OAUTH_TIMEOUT_MS = 10_000;
const GRAPH_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

type Microsoft365OAuthConfig = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
};

/**
 * Resolve the Microsoft app registration. Returns a configuration error when the deployment
 * has not configured it, so the feature fails closed rather than throwing.
 */
export const getMicrosoft365OAuthConfig = (): Result<
  Microsoft365OAuthConfig,
  HandlerError<500>
> => {
  const clientId = env.MICROSOFT_AUTH_CLIENT_ID;
  const clientSecret = env.MICROSOFT_AUTH_CLIENT_SECRET;
  const tenantId = env.MICROSOFT_AUTH_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Microsoft account connection is not configured",
      }),
    );
  }

  return Result.ok({ clientId, clientSecret, tenantId });
};

const authorizeEndpoint = (tenantId: string): string =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;

const tokenEndpoint = (tenantId: string): string =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

export const getMicrosoft365RedirectUri = (): string => {
  const publicUrl = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;
  return new URL("/v1/microsoft365/oauth/callback", publicUrl).toString();
};

const PKCE_VERIFIER_BYTES = 48;
const STATE_BYTES = 32;

const randomBase64Url = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

export const createPkce = () => {
  const codeVerifier = randomBase64Url(PKCE_VERIFIER_BYTES);
  const codeChallenge = hashSha256Base64Url(codeVerifier);
  return { codeChallenge, codeVerifier };
};

export const createOAuthState = (): string => randomBase64Url(STATE_BYTES);

export const buildAuthorizeUrl = ({
  clientId,
  codeChallenge,
  redirectUri,
  state,
  tenantId,
  scope,
}: {
  scope: Microsoft365ReadScopes;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
  tenantId: string;
}): string => {
  const url = new URL(authorizeEndpoint(tenantId));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Force account selection so a user with multiple Microsoft accounts binds
  // the connection to the one they intend.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
};

const graphTokenResponseSchema = v.looseObject({
  access_token: v.string(),
  token_type: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.string()),
});

export type GraphTokenResponse = v.InferOutput<typeof graphTokenResponseSchema>;

const requestToken = async ({
  body,
  tenantId,
}: {
  body: URLSearchParams;
  tenantId: string;
}): Promise<Result<GraphTokenResponse, HandlerError<502>>> =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(tokenEndpoint(tenantId), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        timeout: { type: "idle", ms: GRAPH_OAUTH_TIMEOUT_MS },
        signal: AbortSignal.timeout(GRAPH_OAUTH_TIMEOUT_MS),
        redirect: "error",
      });

      if (!response.ok) {
        throw new HandlerError({
          status: 502,
          message: `Microsoft token endpoint returned HTTP ${response.status}`,
        });
      }

      if (!response.body) {
        throw new HandlerError({
          status: 502,
          message: "Missing Microsoft token response",
        });
      }
      const bytes = await readCappedBytes(
        response.body,
        GRAPH_TOKEN_RESPONSE_MAX_BYTES,
      );
      if (!bytes) {
        throw new HandlerError({
          status: 502,
          message: "Microsoft token response exceeds byte limit",
        });
      }
      return v.parse(
        graphTokenResponseSchema,
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    },
    // Always surface a 502 so the Result error channel unifies to
    // HandlerError<502>; preserve the message when the failure is our own
    // thrown 502 (a non-ok token response).
    catch: (cause): HandlerError<502> =>
      new HandlerError({
        status: 502,
        message: HandlerError.is(cause)
          ? cause.message
          : "Failed to reach the Microsoft token endpoint",
        cause,
      }),
  });

export const exchangeAuthorizationCode = async ({
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri,
  tenantId,
}: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tenantId: string;
}): Promise<Result<GraphTokenResponse, HandlerError<502>>> =>
  await requestToken({
    tenantId,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

export const refreshAccessToken = async ({
  clientId,
  clientSecret,
  refreshToken,
  tenantId,
}: {
  clientId: string;
  clientSecret: string;
  refreshToken: RefreshToken;
  tenantId: string;
}): Promise<Result<GraphTokenResponse, HandlerError<502>>> =>
  await requestToken({
    tenantId,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

export const tokenExpiresAt = (token: GraphTokenResponse): Date | null => {
  if (token.expires_in === undefined || token.expires_in <= 0) {
    return null;
  }
  return new Date(
    Temporal.Now.instant().epochMilliseconds + token.expires_in * 1000,
  );
};
