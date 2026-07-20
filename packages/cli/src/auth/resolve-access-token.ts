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

import { STELLA_API_KEY } from "../env.js";
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
 *  - `ok`: a token usable now (fresh, or freshly refreshed). `persistWarning`
 *    is set when a freshly-refreshed token could not be saved to disk (e.g.
 *    a read-only config dir) — the token is still valid for this command,
 *    but the caller should tell the user the next command will need to
 *    refresh again rather than finding it on disk;
 *  - `unauthenticated`: no stored credential for `serverUrl` at all;
 *  - `refresh-failed`: a credential exists but is expired and could not be
 *    refreshed (no refresh token, metadata discovery failure, or the token
 *    endpoint rejected the refresh) — the caller must fall back to
 *    `stella auth login`.
 */
export type ResolveAccessTokenResult =
  | {
      readonly status: "ok";
      readonly token: string;
      readonly persistWarning?: string;
    }
  | { readonly status: "unauthenticated" }
  | { readonly status: "refresh-failed"; readonly error: CliAuthError };

export const resolveAccessToken = async ({
  configDir,
  serverUrl,
  now = Date.now(),
}: ResolveAccessTokenOptions): Promise<ResolveAccessTokenResult> => {
  // Precedence: `STELLA_API_KEY` beats any stored credential, and when it is set
  // there is no fallback to disk — not even if the key turns out to be invalid.
  //
  // The alternative (try the key, fall back to `credentials.json`) is the more
  // forgiving design and the wrong one here. A CI job or agent that sets this
  // variable is stating which identity the run belongs to; silently falling back
  // would let it execute as whichever human happened to be logged in on that
  // machine, which is both an audit-trail lie and a privilege escalation on a
  // developer workstation. Failing closed makes a bad key look like a bad key.
  //
  // Machine keys carry their own expiry server-side and have no refresh token,
  // so there is deliberately no freshness check or rotation here: an expired key
  // is rejected by the server and must be rotated by an org admin.
  if (STELLA_API_KEY !== undefined && STELLA_API_KEY !== "") {
    return { status: "ok", token: STELLA_API_KEY };
  }

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
    // `ensureFreshCredential` reports this exact tag when a concurrent
    // `auth logout` removed the credential while the exchange was in
    // flight: not a failure to refresh, just "no longer signed in," so this
    // command sees the same outcome as if it had never found a credential.
    if (fresh.error._tag === "CredentialNotFoundError") {
      return { status: "unauthenticated" };
    }
    return { status: "refresh-failed", error: fresh.error };
  }
  if (fresh.value.persistWarning !== undefined) {
    return {
      status: "ok",
      token: fresh.value.credential.accessToken,
      persistWarning: fresh.value.persistWarning,
    };
  }
  return { status: "ok", token: fresh.value.credential.accessToken };
};
