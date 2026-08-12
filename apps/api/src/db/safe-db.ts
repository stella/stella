import { Result } from "better-result";
import type { UnhandledException } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeDbRetryConfig as BaseSafeDbRetryConfig } from "@/api/db/scoped";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import type { DatabaseRlsError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

/**
 * Scoped database handle that wraps every operation in a short-lived RLS
 * transaction. Handlers receive this capability from auth and must not import
 * the owner-level database handle.
 */
export type ScopedDb = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

export type SafeDbError = DatabaseError | DatabaseRlsError | UnhandledException;

export type SafeDbRetryConfig = BaseSafeDbRetryConfig<SafeDbError>;

export const defaultDatabaseRetry: SafeDbRetryConfig = {
  retry: {
    times: 3,
    delayMs: 100,
    backoff: "exponential",
    shouldRetry: (error) =>
      DatabaseError.is(error) &&
      (error.code === PG_ERROR.SERIALIZATION_FAILURE ||
        error.code === PG_ERROR.DEADLOCK_DETECTED),
  },
};

export type SafeDb = <T>(
  fn: (tx: Transaction) => Promise<T>,
  retry?: SafeDbRetryConfig,
) => Promise<Result<T, SafeDbError>>;

/** A safe scoped handle or a transaction already opened by its caller. */
export type SafeDbOrTx =
  | { safeDb: SafeDb; tx?: undefined }
  | { safeDb?: undefined; tx: Transaction };

/**
 * Recover the failure a transaction callback threw to abort itself.
 *
 * Returning a failure value from a transaction callback commits everything the
 * callback has already written, so a business failure found mid-transaction
 * has to throw instead. The scoped factories wrap anything the callback throws
 * that is not a driver error in `UnhandledException`, so the thrown
 * `HandlerError` travels as its cause and this returns it unchanged; a genuine
 * database failure passes through as the error it already was.
 */
export const transactionAbortError = (
  error: SafeDbError,
): HandlerError | SafeDbError =>
  HandlerError.is(error.cause) ? error.cause : error;

export const withScopedTx = async <T>(
  handle: SafeDbOrTx,
  fn: (tx: Transaction) => Promise<T>,
): Promise<Result<T, SafeDbError>> =>
  handle.tx ? Result.ok(await fn(handle.tx)) : await handle.safeDb(fn);
