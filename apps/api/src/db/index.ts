import type { Result, UnhandledException } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeDbRetryConfig as BaseSafeDbRetryConfig } from "@/api/db/scoped";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { DatabaseRlsError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

// Re-export scoped utilities without pulling in the owner-level
// db initialization. Runtime imports from `@/api/db` stay safe for
// handlers and tests; `db` now lives in `@/api/db/root`.
export {
  createIngestionDb,
  createSafeDb,
  createScopedDb,
} from "@/api/db/scoped";
export type { Transaction } from "@/api/db/root";

/**
 * Scoped database handle that wraps every operation in a
 * short-lived RLS transaction. Each call to `scopedDb(fn)`
 * opens a transaction, switches to the `stella` role (which
 * activates RLS), sets `app.workspace_ids` and
 * `app.organization_id` via SET LOCAL, runs `fn`, and
 * commits. The connection returns to the pool immediately
 * after; safe with PgBouncer in transaction mode.
 *
 * Handlers receive this from `authMacro` and must never
 * import `db` directly.
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
