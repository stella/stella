// The single choke point that turns a stored credential into a live bearer
// token for server requests. Everything that authenticates against `serverUrl`
// (the startup registry refresh and every generated command via the shell
// context) resolves its token here instead of reading
// `StoredCredential.accessToken` raw, so the freshness/refresh check can never
// be skipped and an expired-but-refreshable session heals itself in place.
//
// The offline-instant fast path is preserved: a credential still comfortably
// within its lifetime is returned without any network call (no metadata
// discovery, no token round-trip). Only an expired / near-expiry credential
// discovers the token endpoint and refreshes, and the rotated credential is
// persisted so the next command is fast again.

import { Result } from "better-result";

import {
  findDefaultCredential,
  readCredentialFile,
} from "./credential-store.js";
import {
  credentialNeedsRefresh,
  ensureFreshCredential,
  NO_REFRESH_TOKEN_MESSAGE,
} from "./ensure-fresh-credential.js";
import { NoRefreshTokenError } from "./errors.js";
import type { CliAuthError } from "./errors.js";
import { discoverAuthorizationServerMetadata } from "./oauth-metadata.js";

export type ResolveAccessTokenOptions = {
  readonly configDir: string;
  readonly serverUrl: string;
  readonly now?: number;
};

/**
 * Outcome of resolving a live access token:
 *  - `ok`: a token usable now (fresh, or freshly refreshed and persisted);
 *  - `unauthenticated`: no stored credential for `serverUrl` at all;
 *  - `refresh-failed`: a credential exists but is expired and could not be
 *    refreshed (no refresh token, metadata discovery failure, or the token
 *    endpoint rejected the refresh) — the caller must fall back to
 *    `stella auth login`.
 */
export type ResolveAccessTokenResult =
  | { readonly status: "ok"; readonly token: string }
  | { readonly status: "unauthenticated" }
  | { readonly status: "refresh-failed"; readonly error: CliAuthError };

export const resolveAccessToken = async ({
  configDir,
  serverUrl,
  now = Date.now(),
}: ResolveAccessTokenOptions): Promise<ResolveAccessTokenResult> => {
  const credentialFile = await readCredentialFile(configDir);
  const credential = findDefaultCredential(credentialFile, serverUrl);
  if (credential === undefined) {
    return { status: "unauthenticated" };
  }

  // Comfortably valid: hand back the stored token with no network round-trip.
  if (!credentialNeedsRefresh(credential, now)) {
    return { status: "ok", token: credential.accessToken };
  }

  // Expired and unrefreshable: fail closed before spending a discovery request.
  if (credential.refreshToken === undefined) {
    return {
      status: "refresh-failed",
      error: new NoRefreshTokenError({ message: NO_REFRESH_TOKEN_MESSAGE }),
    };
  }

  const metadata = await discoverAuthorizationServerMetadata(serverUrl);
  if (Result.isError(metadata)) {
    return { status: "refresh-failed", error: metadata.error };
  }

  // Re-derive the credential right before the refresh rather than reusing
  // the snapshot from the top of this function: metadata discovery is a
  // network round trip, and another `stella` process (a concurrent command,
  // or `auth login`/`logout` for a different server) may have rotated or
  // removed it while that request was in flight. Retrying with an
  // already-rotated-away refresh token would fail unnecessarily.
  // `ensureFreshCredential` re-reads the file again itself, right before its
  // own write, to close the equivalent window around the token exchange.
  const freshCredentialFile = await readCredentialFile(configDir);
  const freshCredential = findDefaultCredential(freshCredentialFile, serverUrl);
  if (freshCredential === undefined) {
    return { status: "unauthenticated" };
  }

  const fresh = await ensureFreshCredential({
    configDir,
    credential: freshCredential,
    metadata: metadata.value,
    now,
  });
  if (Result.isError(fresh)) {
    return { status: "refresh-failed", error: fresh.error };
  }
  return { status: "ok", token: fresh.value.accessToken };
};
