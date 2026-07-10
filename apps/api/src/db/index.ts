import { Result } from "better-result";
import type { UnhandledException } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeDbRetryConfig as BaseSafeDbRetryConfig } from "@/api/db/scoped";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { DatabaseRlsError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

// Re-export scoped utilities without pulling in the owner-level
// db initialization. Runtime imports from `@/api/db` stay safe for
// handlers and tests; `rootDb` now lives in `@/api/db/root`.
export {
  createIngestionDb,
  createMembershipSafeDb,
  createMembershipScopedDb,
  createSafeDb,
  createScopedDb,
} from "@/api/db/scoped";
export type { Transaction } from "@/api/db/root";

/**
 * Scoped database handle that wraps every operation in a
 * short-lived RLS transaction. Each call to `scopedDb(fn)`
 * opens a transaction, switches to the `stella` role (which
 * activates RLS), sets the transaction-local authorization context, runs `fn`, and
 * commits. The connection returns to the pool immediately
 * after; safe with PgBouncer in transaction mode.
 *
 * Handlers receive this from `authMacro` and must never
 * import `rootDb` directly.
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

/**
 * A read helper's DB handle: either a `SafeDb` that opens its own
 * short-lived scoped transaction, or an already-open `tx` from a
 * transaction a caller opened. Passing `tx` lets several helpers share
 * one transaction (and its single `set_config`) instead of each paying
 * for its own.
 */
export type SafeDbOrTx =
  | { safeDb: SafeDb; tx?: undefined }
  | { safeDb?: undefined; tx: Transaction };

/**
 * Run `fn` against whichever handle a `SafeDbOrTx` carries. With `tx`,
 * `fn` runs directly on the caller's already-open transaction — any
 * thrown error is left to propagate to that transaction's own
 * `safeDb` catch-all, exactly like the raw-`tx` helpers elsewhere in
 * the chat handlers (e.g. `persistent-compaction.ts`). With `safeDb`,
 * a new scoped transaction opens as before.
 */
export const withScopedTx = async <T>(
  handle: SafeDbOrTx,
  fn: (tx: Transaction) => Promise<T>,
): Promise<Result<T, SafeDbError>> =>
  handle.tx ? Result.ok(await fn(handle.tx)) : await handle.safeDb(fn);
