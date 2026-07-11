import { Result } from "better-result";
import type { UnhandledException } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeDbRetryConfig as BaseSafeDbRetryConfig } from "@/api/db/scoped";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
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

export const withScopedTx = async <T>(
  handle: SafeDbOrTx,
  fn: (tx: Transaction) => Promise<T>,
): Promise<Result<T, SafeDbError>> =>
  handle.tx ? Result.ok(await fn(handle.tx)) : await handle.safeDb(fn);
