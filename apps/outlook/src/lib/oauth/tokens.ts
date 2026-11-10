import { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/lib/oauth/discovery";
import { TokenError } from "@/lib/oauth/errors";

const REQUEST_TIMEOUT_MS = 20_000;

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
): Promise<Result<TokenResponse, TokenError>> => {
  const answered = await Result.tryPromise({
    try: async () => {
      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(parameters).toString(),
        credentials: "omit",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json: unknown = await response.json();
      return { status: response.ok ? null : response.status, json };
    },
    catch: (cause) =>
      new TokenError({ message: "The token request failed", cause }),
  });
  if (Result.isError(answered)) {
    return Result.err(answered.error);
  }
  const { status, json } = answered.value;
  if (status !== null) {
    const refusal = v.safeParse(oauthErrorSchema, json);
    return Result.err(
      new TokenError({
        message: `The token endpoint responded ${status}`,
        oauthError: refusal.success ? refusal.output.error : undefined,
        status,
      }),
    );
  }
  const tokens = v.safeParse(tokenResponseSchema, json);
  return tokens.success
    ? Result.ok(tokens.output)
    : Result.err(
        new TokenError({
          message: "The token endpoint answered an unexpected body",
        }),
      );
};

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
 * Whether a refused refresh means the grant itself is gone (revoked,
 * expired, rotated away), so the person has to sign in again. A network
 * failure or a server error leaves the grant to be tried later.
 */
export const isDeadGrant = (error: TokenError): boolean =>
  error.oauthError === "invalid_grant" ||
  error.oauthError === "invalid_client" ||
  error.oauthError === "unauthorized_client" ||
  error.status === 400 ||
  error.status === 401;

/**
 * Revokes the grant at the server (RFC 7009) so a signed-out task pane leaves
 * nothing behind that still works. Without a revocation endpoint the grant is
 * left to expire on its own; the add-in forgets it either way.
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
  const answered = await Result.tryPromise({
    try: async () =>
      await fetch(revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token: refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
        credentials: "omit",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    catch: (cause) =>
      new TokenError({ message: "The revocation request failed", cause }),
  });
  if (Result.isError(answered)) {
    return Result.err(answered.error);
  }
  return answered.value.ok
    ? Result.ok(undefined)
    : Result.err(
        new TokenError({
          message: `The revocation endpoint responded ${answered.value.status}`,
          status: answered.value.status,
        }),
      );
};
