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

  // Re-read right before the refresh/write rather than reusing the snapshot
  // from the top of this function: metadata discovery is a network round
  // trip, and another `stella` process (a concurrent command, or `auth
  // login`/`logout` for a different server) may have written to
  // `credentials.json` while it was in flight. Refreshing off a stale
  // in-memory copy would both retry with a possibly-already-rotated refresh
  // token and, on write, silently clobber that concurrent update —
  // `upsertCredential` merges into whatever `credentialFile` it's handed, so
  // a stale handle here becomes data loss on disk, not just a stale read.
  const freshCredentialFile = await readCredentialFile(configDir);
  const freshCredential = findDefaultCredential(freshCredentialFile, serverUrl);
  if (freshCredential === undefined) {
    return { status: "unauthenticated" };
  }

  const fresh = await ensureFreshCredential({
    configDir,
    credential: freshCredential,
    credentialFile: freshCredentialFile,
    metadata: metadata.value,
    now,
  });
  if (Result.isError(fresh)) {
    return { status: "refresh-failed", error: fresh.error };
  }
  return { status: "ok", token: fresh.value.accessToken };
};
