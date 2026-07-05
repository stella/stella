// Token refresh state machine: called proactively (context/whoami resolution)
// and reactively (a future Phase 3+ HTTP client on a 401) to keep a stored
// credential usable without forcing a full re-login.
//
// Today's server config issues no refresh tokens at all (the oauthProvider's
// `scopes` list has no `offline_access`, which is what
// `@better-auth/oauth-provider` gates refresh-token issuance on — see
// `packages/cli/src/auth/login.ts`'s module comment and the design brief).
// This function is still exercised end-to-end against a mocked provider
// (see `ensure-fresh-credential.test.ts`) so it is ready the moment that
// scope is added server-side; until then every credential this CLI stores
// simply has no `refreshToken` and expires after `ACCESS_TOKEN_EXPIRES_IN`.

import { Result } from "better-result";

import { getMcpResourceUrl } from "./constants.js";
import { upsertCredential, writeCredentialFile } from "./credential-store.js";
import type { CredentialFile, StoredCredential } from "./credential-store.js";
import { NoRefreshTokenError } from "./errors.js";
import type { CliAuthError } from "./errors.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";
import { refreshAccessToken } from "./token-exchange.js";

/** How much of a credential's remaining lifetime triggers a proactive refresh. */
const REFRESH_SKEW_MS = 30_000;

export type EnsureFreshCredentialInput = {
  readonly configDir: string;
  readonly credential: StoredCredential;
  readonly credentialFile: CredentialFile;
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
  if (input.credential.expiresAt - REFRESH_SKEW_MS > now) {
    return Result.ok(input.credential);
  }

  if (!input.credential.refreshToken) {
    return Result.err(
      new NoRefreshTokenError({
        message:
          "The stored access token has expired and no refresh token is available. Run `stella auth login` again.",
      }),
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

  await writeCredentialFile(
    input.configDir,
    upsertCredential(input.credentialFile, updated),
  );

  return Result.ok(updated);
};
