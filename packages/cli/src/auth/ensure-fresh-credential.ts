import { Result } from "better-result";
// Token refresh state machine: called proactively (context/whoami resolution)
// and reactively (a future Phase 3+ HTTP client on a 401) to keep a stored
// credential usable without forcing a full re-login.
//
// `@better-auth/oauth-provider` gates refresh-token issuance on the
// `offline_access` scope, which the CLI requests on every login
// (`CLI_IDENTITY_SCOPES`, not selectable via `--scopes`). A credential can
// still lack a `refreshToken` when the server does not grant that scope; it
// then simply expires after `ACCESS_TOKEN_EXPIRES_IN` and the next command
// asks for a re-login.
import { Temporal } from "temporal-polyfill/full";

import { getMcpResourceUrl } from "./constants.js";
import {
  credentialsFilePath,
  findCredentialByOrgId,
  readCredentialFile,
  updateCredentialFile,
  upsertCredential,
} from "./credential-store.js";
import type { CredentialFile, StoredCredential } from "./credential-store.js";
import {
  CredentialNotFoundError,
  NoRefreshTokenError,
  TokenRefreshError,
} from "./errors.js";
import type { CliAuthError } from "./errors.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";
import { acquireRefreshLock, credentialLockPath } from "./refresh-lock.js";
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
 * `ensureFreshCredential`'s success payload: the credential itself, plus an
 * optional warning when a freshly-refreshed token could not be written to
 * `credentials.json` (read-only config dir, full disk, etc.). The token in
 * `credential` is still valid and safe to use for the command in flight
 * either way — persistence failing doesn't invalidate it, it just means the
 * a later command may have to refresh again instead of finding it on disk.
 */
export type EnsureFreshCredentialOutcome = {
  readonly credential: StoredCredential;
  readonly persistWarning?: string;
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
      readonly result: Result<EnsureFreshCredentialOutcome, CliAuthError>;
    };

const sameGeneration = (
  stored: StoredCredential,
  attempted: StoredCredential,
): boolean =>
  stored.accessToken === attempted.accessToken &&
  stored.refreshToken === attempted.refreshToken &&
  stored.expiresAt === attempted.expiresAt &&
  stored.scope === attempted.scope &&
  stored.updatedAt === attempted.updatedAt;

const checkForNewerStoredGeneration = async (
  input: EnsureFreshCredentialInput,
  now: number,
): Promise<StoredGenerationCheck> => {
  // Re-read under the refresh lock; login/logout can still change the store
  // while the exchange is in flight, so their newer generation takes priority.
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

  const unchangedSinceAttemptStarted = sameGeneration(
    stillPresent,
    input.credential,
  );
  if (unchangedSinceAttemptStarted) {
    return { kind: "unchanged", latestCredentialFile };
  }

  if (!credentialNeedsRefresh(stillPresent, now)) {
    return {
      kind: "resolved",
      result: Result.ok({ credential: stillPresent }),
    };
  }
  // The concurrent writer's own credential is itself already due a refresh
  // (rare — e.g. it raced in with a short-lived token). Retry from this
  // newer generation rather than clobbering it, using it as a failure
  // excuse, or handing back a token that's already stale;
  // `credentialNeedsRefresh` re-checks first on every call, so this
  // terminates once nothing further races in.
  return {
    kind: "resolved",
    result: await refreshCredentialUnderLock({
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
 *
 * Note the `Result` only ever carries an error for states the caller must
 * act on (no credential, expired-and-unrefreshable, a genuine refresh
 * failure). A failure to *persist* an otherwise-successful refresh — the
 * config dir is read-only, the disk is full — is not one of those: the
 * refreshed token is valid in memory regardless, so it comes back as
 * `Result.ok` with `persistWarning` set, not as an error.
 */
const refreshCredentialUnderLock = async (
  input: EnsureFreshCredentialInput,
): Promise<Result<EnsureFreshCredentialOutcome, CliAuthError>> => {
  const now = input.now ?? Temporal.Now.instant().epochMilliseconds;
  if (!credentialNeedsRefresh(input.credential, now)) {
    return Result.ok({ credential: input.credential });
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

  // The shared lock covers only the local generation check and whole-file update.
  // A different credential may finish its exchange at the same time.
  const persisted = await Result.tryPromise(
    async () =>
      await updateCredentialFile(input.configDir, (latest) => {
        const stored = findCredentialByOrgId(
          latest,
          input.credential.serverUrl,
          input.credential.orgId,
        );
        if (stored === undefined || !sameGeneration(stored, input.credential)) {
          return { status: "unchanged", value: "changed" } as const;
        }
        return {
          status: "updated",
          file: upsertCredential(latest, updated),
          value: "persisted",
        } as const;
      }),
  );
  if (Result.isError(persisted)) {
    return Result.ok({
      credential: updated,
      persistWarning: `Warning: refreshed the stella credential but persistence did not complete cleanly at ${credentialsFilePath(input.configDir)} (${persisted.error.message}). This command will use the fresh token; a later command may need to refresh again.`,
    });
  }

  if (persisted.value === "changed") {
    // Resolve or refresh a newer generation after releasing the store lock.
    const check = await checkForNewerStoredGeneration(input, now);
    if (check.kind === "resolved") {
      return check.result;
    }
    return await refreshCredentialUnderLock(input);
  }

  return Result.ok({ credential: updated });
};

export const ensureFreshCredential = async (
  input: EnsureFreshCredentialInput,
): Promise<Result<EnsureFreshCredentialOutcome, CliAuthError>> => {
  const now = input.now ?? Temporal.Now.instant().epochMilliseconds;
  if (!credentialNeedsRefresh(input.credential, now)) {
    return Result.ok({ credential: input.credential });
  }
  if (!input.credential.refreshToken) {
    return Result.err(
      new NoRefreshTokenError({ message: NO_REFRESH_TOKEN_MESSAGE }),
    );
  }
  const lock = await acquireRefreshLock(input.configDir, input.credential);
  if (Result.isError(lock)) {
    return Result.err(lock.error);
  }
  const outcome = await Result.tryPromise(async () => {
    const check = await checkForNewerStoredGeneration(input, now);
    if (check.kind === "resolved") {
      return check.result;
    }
    return await refreshCredentialUnderLock(input);
  });
  const released = await Result.tryPromise(lock.value);
  const recoveryMessage = `Could not remove the credential refresh lock ${credentialLockPath(input.configDir, { serverUrl: input.credential.serverUrl, orgId: input.credential.orgId })}. Confirm no command is refreshing this credential, then remove this lock before retrying.`;
  if (Result.isError(outcome)) {
    return Result.err(
      new TokenRefreshError({
        message: `Could not refresh the stored credential.${Result.isError(released) ? ` ${recoveryMessage}` : ""}`,
        cause: outcome.error,
      }),
    );
  }
  if (Result.isError(released)) {
    if (Result.isError(outcome.value)) {
      return Result.err(
        new TokenRefreshError({
          message: `${outcome.value.error.message} ${recoveryMessage}`,
          cause: outcome.value.error,
        }),
      );
    }
    return Result.ok({
      credential: outcome.value.value.credential,
      persistWarning: [outcome.value.value.persistWarning, recoveryMessage]
        .filter((warning) => warning !== undefined)
        .join(" "),
    });
  }
  return outcome.value;
};
