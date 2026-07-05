// `/oauth2/token` grant handling: authorization_code exchange and
// refresh_token rotation.

import { Result } from "better-result";
import * as v from "valibot";

import { AUTH_FETCH_TIMEOUT_MS } from "./constants.js";
import { TokenExchangeError, TokenRefreshError } from "./errors.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";

// Hand-written rather than `v.InferOutput<typeof schema>` (see
// `cli-config.ts` for why: this package builds with `isolatedDeclarations`).
export type TokenResponse = {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string | undefined;
  readonly scope?: string | undefined;
  readonly token_type: string;
};

const tokenResponseSchema = v.looseObject({
  access_token: v.string(),
  expires_in: v.number(),
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.string()),
  token_type: v.string(),
});

const oauthErrorBodySchema = v.looseObject({
  error: v.string(),
  error_description: v.optional(v.string()),
});

const describeTokenEndpointError = async (
  response: Response,
): Promise<{ error?: string; message: string }> => {
  const text = await response.text();
  const fallback = {
    message:
      text.length > 0 ? text : `token endpoint responded ${response.status}`,
  };

  const parsedJson = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(parsedJson)) {
    return fallback;
  }

  const parsed = v.safeParse(oauthErrorBodySchema, parsedJson.value);
  if (!parsed.success) {
    return fallback;
  }

  return {
    error: parsed.output.error,
    message: parsed.output.error_description ?? parsed.output.error,
  };
};

export type ExchangeAuthorizationCodeInput = {
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly resource: string;
};

export const exchangeAuthorizationCode = async ({
  clientId,
  code,
  codeVerifier,
  metadata,
  redirectUri,
  resource,
}: ExchangeAuthorizationCodeInput): Promise<
  Result<TokenResponse, TokenExchangeError>
> => {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    resource,
  });

  return await Result.tryPromise({
    catch: (cause) =>
      cause instanceof TokenExchangeError
        ? cause
        : new TokenExchangeError({
            cause,
            message: "Failed to exchange the authorization code for a token",
          }),
    try: async () => {
      const response = await fetch(metadata.token_endpoint, {
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const described = await describeTokenEndpointError(response);
        throw new TokenExchangeError({
          message: described.message,
          oauthError: described.error,
        });
      }

      return v.parse(tokenResponseSchema, await response.json());
    },
  });
};

export type RefreshAccessTokenInput = {
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly resource: string;
};

export const refreshAccessToken = async ({
  clientId,
  metadata,
  refreshToken,
  resource,
}: RefreshAccessTokenInput): Promise<
  Result<TokenResponse, TokenRefreshError>
> => {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource,
  });

  return await Result.tryPromise({
    catch: (cause) =>
      cause instanceof TokenRefreshError
        ? cause
        : new TokenRefreshError({
            cause,
            message: "Failed to refresh the access token",
          }),
    try: async () => {
      const response = await fetch(metadata.token_endpoint, {
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const described = await describeTokenEndpointError(response);
        throw new TokenRefreshError({
          message: described.message,
          oauthError: described.error,
        });
      }

      return v.parse(tokenResponseSchema, await response.json());
    },
  });
};
