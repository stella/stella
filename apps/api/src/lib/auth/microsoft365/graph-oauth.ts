import { Result } from "better-result";
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
 * time in the capability scope catalogue, not by discipline.
 */
import * as v from "valibot";

import { classifyFailure } from "@stll/errors";
import { sha256Base64Url as hashSha256Base64Url } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import {
  delegatedReadScopes,
  LEGACY_FILE_CAPABILITIES,
} from "@/api/lib/auth/microsoft365/capabilities";
import { graphResponseFailureReason } from "@/api/lib/auth/microsoft365/graph-response-failure";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { RefreshToken } from "@/api/lib/secret-brands";

const GRAPH_OAUTH_TIMEOUT_MS = 10_000;
const GRAPH_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const FILE_DELEGATED_SCOPES = delegatedReadScopes(LEGACY_FILE_CAPABILITIES);

type SharepointOAuthConfig = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
};

/**
 * Resolve the Microsoft app registration. Missing configuration fails closed
 * through a typed handler error rather than throwing at module import.
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
      classifyFailure(
        new HandlerError({
          status: 500,
          message: "Microsoft account connection is not configured",
        }),
        "tagged_failure",
      ),
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
  return Buffer.from(bytes).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
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
  scope = FILE_DELEGATED_SCOPES,
  state,
  tenantId,
}: {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scope?: string;
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
  fetchBytes = safeOutboundFetchBytes,
  permit,
  signal,
  tenantId,
}: {
  body: URLSearchParams;
  fetchBytes?: typeof safeOutboundFetchBytes;
  permit: ThirdPartyOutboundPermit;
  signal?: AbortSignal | undefined;
  tenantId: string;
}): Promise<Result<GraphTokenResponse, HandlerError<502>>> => {
  const mapError = (cause: unknown): HandlerError<502> =>
    classifyFailure(
      new HandlerError({
        status: 502,
        code: "internal_error",
        message: HandlerError.is(cause)
          ? cause.message
          : "Failed to reach the Microsoft token endpoint",
        cause,
      }),
      "upstream_unavailable",
    );
  return (
    await Result.tryPromise({
      try: async () =>
        await fetchBytes({
          url: tokenEndpoint(tenantId),
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
          maxBytes: GRAPH_TOKEN_RESPONSE_MAX_BYTES,
          permit,
          signal,
          timeoutMs: GRAPH_OAUTH_TIMEOUT_MS,
          redirect: "error",
        }),
      catch: mapError,
    })
  )
    .andThen((response) => response.mapError(mapError))
    .andThen((response) => {
      if (!response.ok) {
        return Result.err(
          classifyFailure(
            new HandlerError({
              status: 502,
              code: "internal_error",
              message: `Microsoft token endpoint returned HTTP ${response.status}`,
            }),
            graphResponseFailureReason(response.status),
          ),
        );
      }
      const json = Result.try((): unknown =>
        JSON.parse(new TextDecoder().decode(response.body)),
      );
      const parsed = Result.isError(json)
        ? null
        : v.safeParse(graphTokenResponseSchema, json.value);
      if (!parsed?.success) {
        return Result.err(
          classifyFailure(
            new HandlerError({
              status: 502,
              code: "internal_error",
              message: "Invalid Microsoft token response",
            }),
            "response_invalid",
          ),
        );
      }
      return Result.ok(parsed.output);
    });
};

export const exchangeSharepointAuthorizationCode = async ({
  clientId,
  clientSecret,
  code,
  codeVerifier,
  fetchBytes,
  permit,
  redirectUri,
  scope = FILE_DELEGATED_SCOPES,
  signal,
  tenantId,
}: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  fetchBytes?: typeof safeOutboundFetchBytes;
  permit: ThirdPartyOutboundPermit;
  redirectUri: string;
  scope?: string;
  signal?: AbortSignal | undefined;
  tenantId: string;
}): Promise<Result<GraphTokenResponse, HandlerError<502>>> =>
  await requestToken({
    tenantId,
    permit,
    ...(fetchBytes ? { fetchBytes } : {}),
    signal,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      scope,
    }),
  });

export const refreshSharepointAccessToken = async ({
  clientId,
  clientSecret,
  fetchBytes,
  permit,
  refreshToken,
  scope,
  signal,
  tenantId,
}: {
  clientId: string;
  clientSecret: string;
  fetchBytes?: typeof safeOutboundFetchBytes;
  permit: ThirdPartyOutboundPermit;
  refreshToken: RefreshToken;
  scope: string;
  signal?: AbortSignal | undefined;
  tenantId: string;
}): Promise<Result<GraphTokenResponse, HandlerError<502>>> =>
  await requestToken({
    tenantId,
    permit,
    ...(fetchBytes ? { fetchBytes } : {}),
    signal,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      scope,
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
