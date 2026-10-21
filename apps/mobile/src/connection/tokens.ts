import { Result } from "better-result";
import * as v from "valibot";

import { TokenError } from "./errors";
import { fetchWithTimeout } from "./http";
import type { Fetch } from "./http";

const tokenResponseSchema = v.object({
  access_token: v.pipe(v.string(), v.minLength(1)),
  expires_in: v.pipe(v.number(), v.minValue(1)),
  refresh_token: v.optional(v.pipe(v.string(), v.minLength(1))),
  token_type: v.string(),
});

export type TokenResponse = v.InferOutput<typeof tokenResponseSchema>;

const oauthErrorSchema = v.object({ error: v.string() });

const requestTokens = async (
  fetch: Fetch,
  tokenEndpoint: string,
  parameters: Record<string, string>,
): Promise<Result<TokenResponse, TokenError>> =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(fetch, tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(parameters).toString(),
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const refusal = v.safeParse(oauthErrorSchema, json);
        throw new TokenError({
          message: `The token endpoint responded ${response.status}`,
          oauthError: refusal.success ? refusal.output.error : undefined,
        });
      }
      return v.parse(tokenResponseSchema, json);
    },
    catch: (cause) =>
      cause instanceof TokenError
        ? cause
        : new TokenError({ message: "The token request failed", cause }),
  });

export const redeemAuthorizationCode = async ({
  clientId,
  code,
  codeVerifier,
  fetch,
  redirectUri,
  resource,
  tokenEndpoint,
}: {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch: Fetch;
  /** The redirect the authorization request named; RFC 6749 §4.1.3 requires the same one. */
  readonly redirectUri: string;
  readonly resource: string;
  readonly tokenEndpoint: string;
}): Promise<Result<TokenResponse, TokenError>> =>
  await requestTokens(fetch, tokenEndpoint, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource,
  });

export const refreshTokens = async ({
  clientId,
  fetch,
  refreshToken,
  resource,
  tokenEndpoint,
}: {
  readonly clientId: string;
  readonly fetch: Fetch;
  readonly refreshToken: string;
  readonly resource: string;
  readonly tokenEndpoint: string;
}): Promise<Result<TokenResponse, TokenError>> =>
  await requestTokens(fetch, tokenEndpoint, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource,
  });

/**
 * Revokes the grant at the server (RFC 7009) so a signed-out phone leaves
 * nothing behind that still works. Without a revocation endpoint the grant
 * is left to expire on its own; the app forgets it either way.
 */
export const revokeRefreshToken = async ({
  clientId,
  fetch,
  refreshToken,
  revocationEndpoint,
}: {
  readonly clientId: string;
  readonly fetch: Fetch;
  readonly refreshToken: string;
  readonly revocationEndpoint: string | undefined;
}): Promise<Result<void, TokenError>> => {
  if (revocationEndpoint === undefined) {
    return Result.ok(undefined);
  }
  return await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(fetch, revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token: refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
      });
      if (!response.ok) {
        throw new TokenError({
          message: `The revocation endpoint responded ${response.status}`,
        });
      }
    },
    catch: (cause) =>
      cause instanceof TokenError
        ? cause
        : new TokenError({ message: "The revocation request failed", cause }),
  });
};
