/**
 * Delegated Microsoft Graph OAuth for the SharePoint / OneDrive connection.
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

import { Result } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import type { RefreshToken } from "@/api/lib/secret-brands";

const GRAPH_OAUTH_TIMEOUT_MS = 10_000;

/** Microsoft Graph v1.0 API base. */
export const GRAPH_API_BASE_URL = "https://graph.microsoft.com/v1.0";

// A scope is read-only unless its (case-insensitive) name contains "write".
// Passing a write scope to `readOnlyScope` makes the argument type `never`,
// so a `*.ReadWrite.*` scope cannot be added to the set below — the bug class
// is structurally impossible rather than caught by a lint or a test.
type ReadOnlyGraphScope<S extends string> =
  Lowercase<S> extends `${string}write${string}` ? never : S;

const readOnlyScope = <const S extends string>(
  scope: ReadOnlyGraphScope<S>,
): S => scope;

/**
 * The delegated scopes requested from Microsoft, all read-only.
 *
 * Admin-consent status of the delegated variants (Microsoft Graph
 * permissions reference, verified 2026-07-28):
 *   - offline_access                          — no admin consent (issues the refresh token)
 *   - https://graph.microsoft.com/User.Read   — no admin consent
 *   - https://graph.microsoft.com/Files.Read.All — admin consent required
 *   - https://graph.microsoft.com/Sites.Read.All — admin consent required (high-impact since 2025)
 *
 * Files.Read.All and Sites.Read.All therefore need a tenant admin to grant
 * consent for the app registration; requesting them here does not change that
 * (it surfaces the consent prompt). No write scope is ever requested.
 */
export const SHAREPOINT_DELEGATED_SCOPES = [
  readOnlyScope("offline_access"),
  readOnlyScope("https://graph.microsoft.com/User.Read"),
  readOnlyScope("https://graph.microsoft.com/Files.Read.All"),
  readOnlyScope("https://graph.microsoft.com/Sites.Read.All"),
] as const;

export type SharepointDelegatedScope =
  (typeof SHAREPOINT_DELEGATED_SCOPES)[number];

/** Runtime read-only predicate (the compile-time guard's mirror, for tests). */
export const isReadOnlyGraphScope = (scope: string): boolean =>
  !scope.toLowerCase().includes("write");

type SharepointOAuthConfig = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
};

/**
 * Resolve the Microsoft app registration. Returns a 503 when the deployment
 * has not configured it, so the feature fails closed rather than throwing.
 */
export const getSharepointOAuthConfig = (): Result<
  SharepointOAuthConfig,
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

export const getSharepointRedirectUri = (): string => {
  const publicUrl = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;
  return new URL("/v1/sharepoint/oauth/callback", publicUrl).toString();
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
  const codeChallenge = new Bun.CryptoHasher("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeChallenge, codeVerifier };
};

export const createOAuthState = (): string => randomBase64Url(STATE_BYTES);

export const buildAuthorizeUrl = ({
  clientId,
  codeChallenge,
  redirectUri,
  state,
  tenantId,
}: {
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
  url.searchParams.set("scope", SHAREPOINT_DELEGATED_SCOPES.join(" "));
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
        timeoutMs: GRAPH_OAUTH_TIMEOUT_MS,
      });

      if (!response.ok) {
        throw new HandlerError({
          status: 502,
          message: `Microsoft token endpoint returned HTTP ${response.status}`,
        });
      }

      return v.parse(graphTokenResponseSchema, await response.json());
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
      scope: SHAREPOINT_DELEGATED_SCOPES.join(" "),
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
      scope: SHAREPOINT_DELEGATED_SCOPES.join(" "),
    }),
  });

export const tokenExpiresAt = (token: GraphTokenResponse): Date | null => {
  if (token.expires_in === undefined || token.expires_in <= 0) {
    return null;
  }
  return new Date(Date.now() + token.expires_in * 1000);
};
