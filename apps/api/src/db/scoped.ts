/**
 * Scoped database utilities — extracted from db/index.ts so
 * test files can import createScopedDb without triggering
 * the prod `rootDb = drizzle(DATABASE_URL, ...)` initialization.
 */

import { Result, UnhandledException } from "better-result";
import { DrizzleQueryError, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_IDS,
  stella,
  stellaIngestion,
} from "@/api/db/rls";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
} from "@/api/lib/errors/tagged-errors";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";

// Generic constraint accepts any drizzle instance (prod or
// test PGlite) without importing test-only types.
type ScopedTransactionBase = {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

export type AnyDrizzle<
  TTransaction extends ScopedTransactionBase = ScopedTransactionBase,
> = {
  transaction: <TResult>(
    fn: (tx: TTransaction) => Promise<TResult>,
  ) => Promise<TResult>;
};

export type TransactionOf<TDatabase extends AnyDrizzle> =
  TDatabase extends AnyDrizzle<infer TTransaction> ? TTransaction : never;

const RLS_DATABASE_MARKER: unique symbol = Symbol("stella.rlsDatabase");

export type RlsDatabaseMarker = {
  readonly [RLS_DATABASE_MARKER]: true;
};

export type RlsDatabase<
  TTransaction extends ScopedTransactionBase = ScopedTransactionBase,
> = AnyDrizzle<TTransaction> & RlsDatabaseMarker;

export const markRlsDatabase = <TDatabase extends AnyDrizzle>(
  database: TDatabase,
): TDatabase & RlsDatabaseMarker =>
  Object.assign(database, { [RLS_DATABASE_MARKER]: true as const });

export type SafeDbRetryConfig<E = unknown> = {
  retry?: {
    times: number;
    delayMs: number;
    backoff: "linear" | "constant" | "exponential";
    shouldRetry?: (error: E) => boolean;
  };
};

type SafeDbError = DatabaseError | DatabaseRlsError | UnhandledException;

const runScopedTransaction = async <
  TTransaction extends ScopedTransactionBase,
  T,
>(
  database: RlsDatabase<TTransaction>,
  workspaceIds: SafeId<"workspace">[],
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
  fn: (tx: TTransaction) => Promise<T>,
): Promise<T> => {
  const wsIds = `{${workspaceIds.join(",")}}`;

  return await database.transaction(async (tx: TTransaction) => {
    await tx.execute(
      sql`SELECT
        set_config('role', '${sql.raw(stella.name)}', true),
        set_config('${sql.raw(SETTING_WORKSPACE_IDS)}', ${wsIds}, true),
        set_config('${sql.raw(SETTING_ORGANIZATION_ID)}', ${organizationId}, true),
        set_config('${sql.raw(SETTING_USER_ID)}', ${userId}, true)`,
    );

    return await fn(tx);
  });
};

export const createScopedDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
    workspaceIds: SafeId<"workspace">[],
    organizationId: SafeId<"organization">,
    userId: SafeId<"user">,
  ) =>
  async <T>(fn: (tx: TTransaction) => Promise<T>): Promise<T> =>
    await runScopedTransaction(
      database,
      workspaceIds,
      organizationId,
      userId,
      fn,
    );

// SET LOCAL ROLE stella_ingestion per transaction. Used by the
// case-law ingestion daemon — narrowed to writes on case_law_*
// (see 20260516000000_case_law_ingestion_role). No app.* settings
// because the corpus is global; there is no tenant to scope.
export const createIngestionDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
  ) =>
  async <T>(fn: (tx: TTransaction) => Promise<T>): Promise<T> =>
    await database.transaction(async (tx: TTransaction) => {
      await tx.execute(
        sql`SELECT set_config('role', '${sql.raw(stellaIngestion.name)}', true)`,
      );
      return await fn(tx);
    });

export const createSafeDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
    workspaceIds: SafeId<"workspace">[],
    organizationId: SafeId<"organization">,
    userId: SafeId<"user">,
  ) =>
  async <T>(
    fn: (tx: TTransaction) => Promise<T>,
    retry?: SafeDbRetryConfig<SafeDbError>,
  ) =>
    await Result.tryPromise(
      {
        try: async () =>
          await runScopedTransaction(
            database,
            workspaceIds,
            organizationId,
            userId,
            fn,
          ),
        catch: (cause): SafeDbError => {
          const code = getPgErrorCode(cause);

          if (code === PG_ERROR.INSUFFICIENT_PRIVILEGE) {
            return new DatabaseRlsError({
              code,
              message: "Database row-level security rejected the request",
              cause,
            });
          }

          if (cause instanceof DrizzleQueryError) {
            return new DatabaseError({
              message: "Database query failed",
              cause,
              code,
            });
          }

          return new UnhandledException({
            cause,
          });
        },
      },
      retry,
    );
