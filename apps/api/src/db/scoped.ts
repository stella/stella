/**
 * Scoped database utilities — extracted from db/index.ts so
 * test files can import createScopedDb without triggering
 * the prod `db = drizzle(DATABASE_URL, ...)` initialization.
 */

import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_WORKSPACE_IDS,
  stella,
} from "@/api/db/rls";
import type { SafeId } from "@/api/lib/branded-types";

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

export const createScopedDb = <TTransaction extends ScopedTransactionBase>(
  database: AnyDrizzle<TTransaction>,
  workspaceIds: SafeId<"workspace">[],
  organizationId: SafeId<"organization">,
) => {
  const wsIds = `{${workspaceIds.join(",")}}`;

  return async <T>(fn: (tx: TTransaction) => Promise<T>): Promise<T> =>
    await database.transaction(async (tx: TTransaction) => {
      await tx.execute(
        sql`SELECT
          set_config('role', '${sql.raw(stella.name)}', true),
          set_config('${sql.raw(SETTING_WORKSPACE_IDS)}', ${wsIds}, true),
          set_config('${sql.raw(SETTING_ORGANIZATION_ID)}', ${organizationId}, true)`,
      );
      return fn(tx);
    });
};
