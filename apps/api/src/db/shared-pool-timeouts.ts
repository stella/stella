import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  clampSharedPoolTimeout,
  parsePostgresTimeoutMs,
  resolveSharedPoolTimeoutPolicy,
} from "@/api/db/shared-pool-timeout-policy";
import { envDbTimeouts } from "@/api/env-db-timeouts";
import { executedRows } from "@/api/lib/db/executed-rows";

/** Request budgets only; background and authenticated reads retain their policy. */
export const PUBLIC_READ_STATEMENT_TIMEOUT_MS = {
  browse: 30_000,
  search: 30_000,
  aggregate: 30_000,
  sitemap: 30_000,
} as const;

export const sharedPoolTimeoutPolicy = resolveSharedPoolTimeoutPolicy({
  idleTimeoutSeconds: envDbTimeouts.DATABASE_POOL_IDLE_TIMEOUT_S,
  requestedStatementTimeoutMs: envDbTimeouts.DATABASE_STATEMENT_TIMEOUT_MS,
});

type TimeoutTransaction = { execute: (query: SQL) => Promise<unknown> };

const effectiveTimeout = (requestedMs: number): number =>
  clampSharedPoolTimeout(requestedMs, sharedPoolTimeoutPolicy);

type SharedQueryTimeouts = {
  statementTimeoutMs: number;
  lockTimeoutMs?: number;
};

export const setSharedQueryTimeouts = async (
  query: (
    statement: string,
    parameters?: readonly (string | number | null)[],
  ) => Promise<unknown>,
  { statementTimeoutMs, lockTimeoutMs }: SharedQueryTimeouts,
): Promise<void> => {
  const statementTimeout = `${effectiveTimeout(statementTimeoutMs)}ms`;
  if (lockTimeoutMs === undefined) {
    await query("SELECT set_config('statement_timeout', $1, true)", [
      statementTimeout,
    ]);
    return;
  }
  await query(
    "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
    [statementTimeout, `${effectiveTimeout(lockTimeoutMs)}ms`],
  );
};

export const setSharedStatementTimeout = async (
  tx: TimeoutTransaction,
  requestedMs: number,
): Promise<void> => {
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${`${effectiveTimeout(requestedMs)}ms`}, true)`,
  );
};

export const setSharedLockTimeout = async (
  tx: TimeoutTransaction,
  requestedMs: number,
): Promise<void> => {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${`${effectiveTimeout(requestedMs)}ms`}, true)`,
  );
};

export const setSharedTransactionTimeouts = async (
  tx: TimeoutTransaction,
  { statementTimeoutMs, lockTimeoutMs }: SharedQueryTimeouts,
): Promise<void> => {
  const lock =
    lockTimeoutMs === undefined
      ? sql``
      : sql`, set_config('lock_timeout', ${`${effectiveTimeout(lockTimeoutMs)}ms`}, true)`;
  await tx.execute(sql`SELECT
    set_config('statement_timeout', ${`${effectiveTimeout(statementTimeoutMs)}ms`}, true)
    ${lock}`);
};

type TransactionTimeouts = Required<SharedQueryTimeouts>;

/** Restore the captured settings after the caller has settled its savepoint. */
export const withSharedTransactionTimeoutRestoration = async <T>(
  tx: TimeoutTransaction,
  fn: (previous: TransactionTimeouts) => Promise<T>,
): Promise<T> => {
  const row = executedRows(
    await tx.execute(sql`SELECT
      current_setting('statement_timeout') AS statement_timeout,
      current_setting('lock_timeout') AS lock_timeout`),
  ).at(0);
  if (
    typeof row !== "object" ||
    row === null ||
    !("statement_timeout" in row) ||
    !("lock_timeout" in row) ||
    typeof row.statement_timeout !== "string" ||
    typeof row.lock_timeout !== "string"
  ) {
    panic("PostgreSQL did not return transaction timeouts");
  }
  const previous = {
    statementTimeoutMs: parsePostgresTimeoutMs(row.statement_timeout),
    lockTimeoutMs: parsePostgresTimeoutMs(row.lock_timeout),
  };
  const outcome = await Result.tryPromise({
    try: async () => await fn(previous),
    catch: (cause) => cause,
  });
  // Restore only the captured settings, including disabled timeouts. A failed
  // savepoint cleanup may leave the transaction aborted; preserve its error.
  const restoration = await Result.tryPromise({
    try: async () =>
      await tx.execute(sql`SELECT
    set_config('statement_timeout', ${`${previous.statementTimeoutMs}ms`}, true),
    set_config('lock_timeout', ${`${previous.lockTimeoutMs}ms`}, true)`),
    catch: (cause) => cause,
  });
  if (outcome.isErr()) {
    throw outcome.error;
  }
  if (restoration.isErr()) {
    throw restoration.error;
  }
  return outcome.value;
};

type SharedReadGuards = {
  statementTimeoutMs: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  /**
   * A deadline for the whole transaction, counted from this statement.
   * `statement_timeout` restarts with every statement, so only this bounds
   * a run of statements: past it the server ends the session, whatever the
   * transaction is doing.
   */
  transactionTimeoutMs?: number;
};

/** Install the public read guards together so setup costs one round trip. */
export const setSharedReadTransactionGuards = async (
  tx: TimeoutTransaction,
  {
    statementTimeoutMs,
    lockTimeoutMs,
    idleInTransactionTimeoutMs,
    transactionTimeoutMs,
  }: SharedReadGuards,
): Promise<void> => {
  const transaction =
    transactionTimeoutMs === undefined
      ? sql``
      : sql`, set_config('transaction_timeout', ${`${effectiveTimeout(transactionTimeoutMs)}ms`}, true)`;
  const lock =
    lockTimeoutMs === undefined
      ? sql``
      : sql`, set_config('lock_timeout', ${`${effectiveTimeout(lockTimeoutMs)}ms`}, true)`;
  const idle =
    idleInTransactionTimeoutMs === undefined
      ? sql``
      : sql`, set_config('idle_in_transaction_session_timeout', ${`${effectiveTimeout(idleInTransactionTimeoutMs)}ms`}, true)`;
  await tx.execute(sql`
    SELECT
      set_config('transaction_read_only', 'on', true),
      set_config('statement_timeout', ${`${effectiveTimeout(statementTimeoutMs)}ms`}, true)
      ${lock}
      ${idle}
      ${transaction}
  `);
};

const readCurrentStatementTimeoutMs = async (
  tx: TimeoutTransaction,
): Promise<number> => {
  const row = executedRows(
    await tx.execute(
      sql`SELECT current_setting('statement_timeout') AS statement_timeout`,
    ),
  ).at(0);
  const value =
    typeof row === "object" && row !== null && "statement_timeout" in row
      ? row.statement_timeout
      : undefined;
  if (typeof value !== "string") {
    panic("PostgreSQL did not return statement_timeout");
  }
  return parsePostgresTimeoutMs(value);
};

export const withSharedStatementTimeout = async <T>(
  tx: TimeoutTransaction,
  requestedMs: number,
  fn: () => Promise<T>,
): Promise<T> => {
  const previousMs = await readCurrentStatementTimeoutMs(tx);
  const nestedMs =
    previousMs > 0 ? Math.min(requestedMs, previousMs) : requestedMs;
  await setSharedStatementTimeout(tx, nestedMs);
  const outcome = await fn().then(
    (value) => ({ status: "fulfilled", value }) as const,
    (error: unknown) => ({ status: "rejected", error }) as const,
  );
  // A server cancellation aborts the transaction, so restoration may fail;
  // keep the original query error while its transaction rolls back.
  const restoration = await (async () => {
    if (previousMs === 0 && sharedPoolTimeoutPolicy.idleTimeoutMs === 0) {
      await tx.execute(sql`SELECT set_config('statement_timeout', '0', true)`);
    } else {
      await setSharedStatementTimeout(
        tx,
        previousMs ||
          (sharedPoolTimeoutPolicy.effectiveStatementTimeoutMs ?? requestedMs),
      );
    }
  })().then(
    () => ({ status: "fulfilled" }) as const,
    (error: unknown) => ({ status: "rejected", error }) as const,
  );
  if (outcome.status === "rejected") {
    throw outcome.error;
  }
  if (restoration.status === "rejected") {
    throw restoration.error;
  }
  return outcome.value;
};
