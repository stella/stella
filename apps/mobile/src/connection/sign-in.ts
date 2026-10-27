import { Result } from "better-result";

import { buildAuthorizeUrl, readAuthorizationCallback } from "./authorize";
import { resolveClientId } from "./client-id";
import { discoverAuthorizationServer } from "./discovery";
import {
  AuthorizationError,
  type ClientRegistrationError,
  type DiscoveryError,
  type ServerUrlError,
  TokenError,
} from "./errors";
import type { Fetch } from "./http";
import {
  type AuthorizationCrypto,
  createAuthorizationState,
  createPkcePair,
} from "./pkce";
import { parseServerUrl } from "./server-url";
import type { TransportPolicy } from "./server-url";
import type { AccessToken, StoredSession } from "./session";
import { redeemAuthorizationCode } from "./tokens";

/**
 * Where the person approves the request: the system's authentication
 * session, which shares the browser's sign-in but not the app's memory.
 */
export type OpenAuthSession = (
  authorizeUrl: string,
  redirectUri: string,
) => Promise<{ type: "success"; url: string } | { type: "cancel" }>;

export type SignInError =
  | ServerUrlError
  | DiscoveryError
  | ClientRegistrationError
  | AuthorizationError
  | TokenError;

export type SignedIn = {
  readonly session: StoredSession;
  readonly access: AccessToken;
};

/**
 * Signs the app in to the server a person named: discovery, the app's
 * client id, PKCE, the person's approval in the browser, then the code
 * exchange. `resourceFor` names the token's audience on that server.
 */
export const signIn = async ({
  crypto,
  fetch,
  now,
  openAuthSession,
  redirectUri,
  resourceFor,
  serverUrlInput,
  transport,
}: {
  readonly crypto: AuthorizationCrypto;
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly openAuthSession: OpenAuthSession;
  /** This build's redirect (`mobileRedirectUri`). */
  readonly redirectUri: string;
  readonly resourceFor: (serverUrl: string) => string;
  readonly serverUrlInput: string;
  readonly transport: TransportPolicy;
}): Promise<Result<SignedIn, SignInError>> =>
  await Result.gen(async function* () {
    const serverUrl = yield* parseServerUrl(serverUrlInput, transport);
    const metadata = yield* Result.await(
      discoverAuthorizationServer(fetch, serverUrl, transport),
    );
    const resource = resourceFor(serverUrl);
    const clientId = yield* Result.await(
      resolveClientId({ fetch, metadata, redirectUri, resource }),
    );
    const pkce = await createPkcePair(crypto);
    const state = createAuthorizationState(crypto);
    const outcome = await openAuthSession(
      buildAuthorizeUrl({
        clientId,
        codeChallenge: pkce.codeChallenge,
        metadata,
        redirectUri,
        resource,
        state,
      }),
      redirectUri,
    );
    if (outcome.type === "cancel") {
      return Result.err(
        new AuthorizationError({
          message: "The sign-in was closed before it finished",
          failure: "cancelled",
        }),
      );
    }
    const code = yield* readAuthorizationCallback({
      callbackUrl: outcome.url,
      expectedIssuer: metadata.issuer,
      expectedState: state,
      issuerRequired:
        metadata.authorization_response_iss_parameter_supported === true,
      redirectUri,
    });
    const tokens = yield* Result.await(
      redeemAuthorizationCode({
        fetch,
        clientId,
        code,
        codeVerifier: pkce.codeVerifier,
        redirectUri,
        resource,
        tokenEndpoint: metadata.token_endpoint,
      }),
    );
    if (tokens.refresh_token === undefined) {
      return Result.err(
        new TokenError({
          message:
            "The server issued no refresh token, so the session would end with its first access token",
        }),
      );
    }
    return Result.ok({
      session: {
        serverUrl,
        issuer: metadata.issuer,
        clientId,
        tokenEndpoint: metadata.token_endpoint,
        revocationEndpoint: metadata.revocation_endpoint,
        resource,
        refreshToken: tokens.refresh_token,
      },
      access: {
        token: tokens.access_token,
        expiresAt: now() + tokens.expires_in * 1000,
      },
    });
  });
