import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  clampSharedPoolTimeout,
  parsePostgresTimeoutMs,
  resolveSharedPoolTimeoutPolicy,
} from "@/api/db/shared-pool-timeout-policy";
import { envBase } from "@/api/env-base";
import { executedRows } from "@/api/lib/db/executed-rows";
import { logger } from "@/api/lib/observability/logger";

export const sharedPoolTimeoutPolicy = resolveSharedPoolTimeoutPolicy({
  idleTimeoutSeconds: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
  requestedStatementTimeoutMs: envBase.DATABASE_STATEMENT_TIMEOUT_MS,
});

type TimeoutTransaction = { execute: (query: SQL) => Promise<unknown> };
type SharedPoolName = "root" | "raw_rls" | "public_law";

const effectiveTimeout = (requestedMs: number): number =>
  clampSharedPoolTimeout(requestedMs, sharedPoolTimeoutPolicy);

export const sharedPoolConnectionSettings = (pool: SharedPoolName) => {
  const policy = sharedPoolTimeoutPolicy;
  logger.info("database.shared_pool_timeout_configured", {
    pool,
    idleTimeoutMs: policy.idleTimeoutMs,
    requestedStatementTimeoutMs: policy.requestedStatementTimeoutMs,
    effectiveStatementTimeoutMs:
      policy.effectiveStatementTimeoutMs ?? "server_default",
    capMs: policy.capMs ?? 0,
    marginMs: policy.marginMs ?? 0,
    clamped: policy.clamped,
  });
  return policy.effectiveStatementTimeoutMs === null
    ? {}
    : { connection: { statement_timeout: policy.effectiveStatementTimeoutMs } };
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
          sharedPoolTimeoutPolicy.effectiveStatementTimeoutMs ||
          requestedMs,
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
