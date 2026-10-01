import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  clampSharedPoolTimeout,
  parsePostgresTimeoutMs,
  resolveSharedPoolTimeoutPolicy,
} from "@/api/db/shared-pool-timeout-policy";
import { envDbTimeouts } from "@/api/env-db-timeouts";
import { executedRows } from "@/api/lib/db/executed-rows";

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

type SharedReadGuards = {
  statementTimeoutMs: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
};

/** Install the public read guards together so setup costs one round trip. */
export const setSharedReadTransactionGuards = async (
  tx: TimeoutTransaction,
  {
    statementTimeoutMs,
    lockTimeoutMs,
    idleInTransactionTimeoutMs,
  }: SharedReadGuards,
): Promise<void> => {
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
