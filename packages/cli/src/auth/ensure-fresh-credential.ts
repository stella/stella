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
import type { CredentialFile, StoredCredential } from "./credential-store.js";
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
 * The seam shared by every place this module needs to answer "did a
 * concurrent `stella` process already move this exact (serverUrl, orgId)
 * credential out from under this refresh attempt, and if so to what":
 *
 *  - `unchanged`: the stored entry still matches the generation this
 *    attempt started from (`input.credential`) — nothing raced in, so the
 *    caller proceeds with its own outcome (write the token it just
 *    refreshed, or surface the token-endpoint error it just got).
 *  - `resolved`: something did move. `CredentialNotFoundError` when the
 *    entry is gone — a concurrent `auth logout` wins over anything this
 *    attempt concluded, success or failure, so writing/using this
 *    attempt's result would resurrect a credential the user signed out of.
 *    Otherwise the fresher stored credential, refreshed further (from that
 *    newer generation, reusing the already-discovered `metadata`) if it
 *    turns out to itself already be due a refresh.
 */
type StoredGenerationCheck =
  | {
      readonly kind: "unchanged";
      readonly latestCredentialFile: CredentialFile;
    }
  | {
      readonly kind: "resolved";
      readonly result: Result<StoredCredential, CliAuthError>;
    };

const checkForNewerStoredGeneration = async (
  input: EnsureFreshCredentialInput,
  now: number,
): Promise<StoredGenerationCheck> => {
  // Re-read right before deciding rather than trusting any snapshot the
  // caller took earlier: both the token exchange and metadata discovery
  // that precede this check are network round trips, during which another
  // `stella` process (a concurrent command, or `auth login`/`logout`) may
  // have written to `credentials.json`. This keeps that window as small as
  // this process can make it without a lock (full read-modify-write
  // atomicity — a store-level lock or true compare-and-swap across the
  // whole critical section — is a separate, tracked follow-up: this is a
  // compare-and-skip, not a swap).
  const latestCredentialFile = await readCredentialFile(input.configDir);
  const stillPresent = findCredentialByOrgId(
    latestCredentialFile,
    input.credential.serverUrl,
    input.credential.orgId,
  );
  if (stillPresent === undefined) {
    return {
      kind: "resolved",
      result: Result.err(
        new CredentialNotFoundError({
          message: `Not signed in to ${input.credential.serverUrl}. Run \`stella auth login\`.`,
          org: input.credential.orgId,
          serverUrl: input.credential.serverUrl,
        }),
      ),
    };
  }

  const unchangedSinceAttemptStarted =
    stillPresent.accessToken === input.credential.accessToken &&
    stillPresent.refreshToken === input.credential.refreshToken &&
    stillPresent.expiresAt === input.credential.expiresAt &&
    stillPresent.scope === input.credential.scope &&
    stillPresent.updatedAt === input.credential.updatedAt;
  if (unchangedSinceAttemptStarted) {
    return { kind: "unchanged", latestCredentialFile };
  }

  if (!credentialNeedsRefresh(stillPresent, now)) {
    return { kind: "resolved", result: Result.ok(stillPresent) };
  }
  // The concurrent writer's own credential is itself already due a refresh
  // (rare — e.g. it raced in with a short-lived token). Retry from this
  // newer generation rather than clobbering it, using it as a failure
  // excuse, or handing back a token that's already stale;
  // `credentialNeedsRefresh` re-checks first on every call, so this
  // terminates once nothing further races in.
  return {
    kind: "resolved",
    result: await ensureFreshCredential({
      ...input,
      credential: stillPresent,
      now,
    }),
  };
};

/**
 * Returns a credential guaranteed usable "now" (with `REFRESH_SKEW_MS` of
 * slack), refreshing and persisting it first if it is expired or about to
 * expire. Errors when the credential is expired and either has no refresh
 * token or the refresh call itself fails — both cases mean the caller must
 * fall back to `stella auth login`. A refresh-call failure is only trusted
 * once a re-read confirms no concurrent process already landed newer
 * tokens (see `checkForNewerStoredGeneration`): the OAuth server may have
 * rotated the refresh token out from under this exact exchange because a
 * racing `stella` invocation already won it.
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
    const check = await checkForNewerStoredGeneration(input, now);
    if (check.kind === "resolved") {
      return check.result;
    }
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

  const check = await checkForNewerStoredGeneration(input, now);
  if (check.kind === "resolved") {
    return check.result;
  }

  await writeCredentialFile(
    input.configDir,
    upsertCredential(check.latestCredentialFile, updated),
  );

  return Result.ok(updated);
};
