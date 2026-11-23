import type { Result, UnhandledException } from "better-result";

import type {
  CreateIngestionDbOptions,
  SafeDbRetryConfig as BaseSafeDbRetryConfig,
} from "@/api/db/scoped";
import type { Transaction } from "@/api/db/types";
import type {
  DatabaseError,
  DatabaseRlsError,
} from "@/api/lib/errors/tagged-errors";

/**
 * Scoped database handle that wraps every operation in a short-lived RLS
 * transaction. Handlers receive this capability from auth and must not import
 * the owner-level database handle.
 */
export type ScopedDb<TTransaction = Transaction> = <T>(
  fn: (tx: TTransaction) => Promise<T>,
) => Promise<T>;

/** Corpus operations can bound schema-lane waits; createIngestionDb honors these budgets. */
export type IngestionScopedDb = <T>(
  fn: (tx: Transaction) => Promise<T>,
  options?: CreateIngestionDbOptions,
) => Promise<T>;

export type SafeDbError = DatabaseError | DatabaseRlsError | UnhandledException;

export type SafeDbRetryConfig = BaseSafeDbRetryConfig<SafeDbError>;

export type SafeDb<TTransaction = Transaction> = <T>(
  fn: (tx: TTransaction) => Promise<T>,
  retry?: SafeDbRetryConfig,
) => Promise<Result<T, SafeDbError>>;

/** A safe scoped handle or a transaction already opened by its caller. */
export type SafeDbOrTx =
  { safeDb: SafeDb; tx?: undefined } | { safeDb?: undefined; tx: Transaction };
