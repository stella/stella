/**
 * Keeps one bucket's object-store clients on live credentials for the length
 * of a process.
 *
 * Both S3 clients this codebase builds capture their credentials as
 * constructor values. On ECS those credentials come from the task role and the
 * container endpoint rotates them, so a process that outlives one rotation —
 * an ingestion replay, a corpus backfill, a document worker — signs every
 * later request with a token the service refuses. The API server polls its
 * staleness clock on a timer; a one-off task has no such loop, which is why
 * the refresh belongs at the operation rather than at every caller.
 */
import { Result } from "better-result";

import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Codes S3, STS and both SDKs report for a request signed with credentials
 * that have passed their expiry. Each clears on a fresh credential set, which
 * is what separates them from `InvalidAccessKeyId` or `SignatureDoesNotMatch`:
 * those name a credential that is wrong rather than old, and resolving again
 * returns the same rejection.
 */
const EXPIRED_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "RequestExpired",
  "TokenRefreshRequired",
]);

/**
 * The AWS SDK surfaces an error it has no model for as `S3ServiceException`
 * carrying only the service's sentence, so the sentence is matched alongside
 * the code. Three spellings reach here: Bun's client reports `code`, the AWS
 * SDK reports `name`, and a presigned read reports the `<Code>` it read off
 * the response body.
 */
const EXPIRED_CREDENTIAL_MESSAGE = "token has expired";

const errorStringField = (
  error: Record<string, unknown>,
  field: string,
): string | null => {
  const value = error[field];
  return typeof value === "string" ? value : null;
};

export const isExpiredCredentialsError = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }
  const code = errorStringField(error, "code");
  if (code !== null && EXPIRED_CREDENTIAL_CODES.has(code)) {
    return true;
  }
  const name = errorStringField(error, "name");
  if (name !== null && EXPIRED_CREDENTIAL_CODES.has(name)) {
    return true;
  }
  const message = errorStringField(error, "message");
  return message?.toLowerCase().includes(EXPIRED_CREDENTIAL_MESSAGE) === true;
};

export type S3CredentialLifecycle = {
  /** Whether the built clients' credentials have passed their horizon. */
  isStale: () => boolean;
  /** Rebuild the clients from a fresh credential resolution. */
  refresh: () => Promise<void>;
};

export type S3CredentialGuard = {
  /** Rebuild the clients when their credentials are past the horizon. */
  refreshStale: () => Promise<void>;
  /**
   * Run one object-store operation against credentials that are current.
   *
   * Refreshing first covers the ordinary case. Replaying the operation once
   * after a forced rebuild covers a set that expired between the staleness
   * check and the request. A second expired-token failure is not a
   * credential-age problem, so it reaches the caller.
   *
   * `operation` reads its client at call time and owns any state it
   * accumulates: the replay runs it from the start.
   */
  run: <T>(operation: () => Promise<T>) => Promise<T>;
};

export const createS3CredentialGuard = ({
  isStale,
  refresh,
}: S3CredentialLifecycle): S3CredentialGuard => {
  // Credential resolution reaches the network and the rebuilt clients are
  // process-wide, so concurrent operations share the one rebuild in flight. A
  // failed rebuild is not cached: the next operation resolves again.
  let inFlight: Promise<void> | null = null;

  // Every rebuild in this module goes through here, the staleness one and the
  // forced one alike. Credentials rotate for the whole process at once, so a
  // burst of operations that all discover the expiry together must cost one
  // endpoint request and one client swap, not one per operation. Joining a
  // rebuild already in flight is safe for a forced refresh too: it resolves
  // against the endpoint as it runs, so it cannot hand back the credentials
  // that just failed.
  // The assignment runs before the first await, so callers arriving in the
  // same tick all observe the one promise.
  const refreshOnce = async (): Promise<void> => {
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    await inFlight;
  };

  const refreshStale = async (): Promise<void> => {
    if (!isStale()) {
      return;
    }
    await refreshOnce();
  };

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    await refreshStale();
    const attempted = operation();
    const outcome = await Result.tryPromise({
      try: async () => await attempted,
      catch: (cause) => cause,
    });
    if (Result.isOk(outcome)) {
      return outcome.value;
    }
    if (isExpiredCredentialsError(outcome.error)) {
      logger.warn("s3.credentials_expired_retry", {
        "error.type": errorTag(outcome.error),
      });
      await refreshOnce();
      return await operation();
    }
    // The failure is the store's, and this module has nothing to add to it:
    // callers match on the SDK's own error name. Awaiting the settled
    // rejection re-raises that exact error rather than rethrowing a copy of
    // it, so the guard never manufactures a failure of its own.
    return await attempted;
  };

  return { refreshStale, run };
};
