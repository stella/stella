// Token refresh state machine: called proactively (context/whoami resolution)
// and reactively (a future Phase 3+ HTTP client on a 401) to keep a stored
// credential usable without forcing a full re-login.
//
// `@better-auth/oauth-provider` gates refresh-token issuance on the
// `offline_access` scope, which the stella server grants and
// `CLI_DEFAULT_SCOPES` requests by default. A credential can still lack a
// `refreshToken` (explicit `--scopes` without `offline_access`, or an older
// self-hosted server that does not grant it); it then simply expires after
// `ACCESS_TOKEN_EXPIRES_IN` and the next command asks for a re-login.

import { Result } from "better-result";

import { getMcpResourceUrl } from "./constants.js";
import {
  findCredentialByOrgId,
  readCredentialFile,
  upsertCredential,
  writeCredentialFile,
} from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";
import { CredentialNotFoundError, NoRefreshTokenError } from "./errors.js";
import type { CliAuthError } from "./errors.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";
import { refreshAccessToken } from "./token-exchange.js";

/** How much of a credential's remaining lifetime triggers a proactive refresh. */
const REFRESH_SKEW_MS = 30_000;

/**
 * Shared message for the "expired, and no way to refresh" terminal state, used
 * both here and by the `resolveAccessToken` accessor so the two callers never
 * drift.
 */
export const NO_REFRESH_TOKEN_MESSAGE =
  "The stored access token has expired and no refresh token is available. Run `stella auth login` again.";

/**
 * Whether `credential` is expired or within `REFRESH_SKEW_MS` of expiring at
 * `now` — i.e. a proactive refresh is worth attempting. Callers gate the
 * network-bearing discovery + token exchange on this so a comfortably-valid
 * credential stays offline-instant.
 */
export const credentialNeedsRefresh = (
  credential: Pick<StoredCredential, "expiresAt">,
  now: number,
): boolean => credential.expiresAt - REFRESH_SKEW_MS <= now;

export type EnsureFreshCredentialInput = {
  readonly configDir: string;
  readonly credential: StoredCredential;
  readonly metadata: AuthorizationServerMetadata;
  readonly now?: number;
};

/**
 * Returns a credential guaranteed usable "now" (with `REFRESH_SKEW_MS` of
 * slack), refreshing and persisting it first if it is expired or about to
 * expire. Errors when the credential is expired and either has no refresh
 * token or the refresh call itself fails — both cases mean the caller must
 * fall back to `stella auth login`.
 */
export const ensureFreshCredential = async (
  input: EnsureFreshCredentialInput,
): Promise<Result<StoredCredential, CliAuthError>> => {
  const now = input.now ?? Date.now();
  if (!credentialNeedsRefresh(input.credential, now)) {
    return Result.ok(input.credential);
  }

  if (!input.credential.refreshToken) {
    return Result.err(
      new NoRefreshTokenError({ message: NO_REFRESH_TOKEN_MESSAGE }),
    );
  }

  const refreshed = await refreshAccessToken({
    clientId: input.credential.clientId,
    metadata: input.metadata,
    refreshToken: input.credential.refreshToken,
    resource: getMcpResourceUrl(input.credential.serverUrl),
  });
  if (Result.isError(refreshed)) {
    return Result.err(refreshed.error);
  }

  const updated: StoredCredential = {
    ...input.credential,
    accessToken: refreshed.value.access_token,
    expiresAt: now + refreshed.value.expires_in * 1000,
    refreshToken:
      refreshed.value.refresh_token ?? input.credential.refreshToken,
    scope: refreshed.value.scope ?? input.credential.scope,
    updatedAt: now,
  };

  // Re-read right before the write rather than trusting any snapshot the
  // caller took earlier: `refreshAccessToken` above is a network round trip,
  // during which another `stella` process (a concurrent command, or `auth
  // login`/`logout` for a different server) may have written to
  // `credentials.json`. Merging into the file as it stands right now — not
  // as it stood before the exchange — keeps that window as small as this
  // process can make it without a lock (full read-modify-write atomicity is
  // a separate, tracked follow-up).
  const latestCredentialFile = await readCredentialFile(input.configDir);

  // The exchange itself doesn't prove this exact (serverUrl, orgId)
  // credential is still meant to exist: a concurrent `stella auth logout`
  // may have removed it while the refresh request was in flight. Writing
  // the refreshed token back unconditionally would resurrect a credential
  // the user explicitly signed out of — fail the same way as "never had a
  // credential" instead of reviving it.
  const stillPresent = findCredentialByOrgId(
    latestCredentialFile,
    input.credential.serverUrl,
    input.credential.orgId,
  );
  if (stillPresent === undefined) {
    return Result.err(
      new CredentialNotFoundError({
        message: `Not signed in to ${input.credential.serverUrl}. Run \`stella auth login\`.`,
        org: input.credential.orgId,
        serverUrl: input.credential.serverUrl,
      }),
    );
  }

  await writeCredentialFile(
    input.configDir,
    upsertCredential(latestCredentialFile, updated),
  );

  return Result.ok(updated);
};
