/**
 * Scoped database utilities — extracted from db/index.ts so
 * test files can import createScopedDb without triggering
 * the prod `db = drizzle(DATABASE_URL, ...)` initialization.
 */

import { sql } from "drizzle-orm";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_WORKSPACE_IDS,
  stella,
} from "@/api/db/rls";
import type { SafeId } from "@/api/lib/branded-types";

// Generic constraint accepts any drizzle instance (prod or
// test PGlite) without importing test-only types.
export type AnyDrizzle = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: (fn: (tx: any) => any) => any;
};

export type TransactionOf<TDatabase extends AnyDrizzle> = Parameters<
  Parameters<TDatabase["transaction"]>[0]
>[0];

export const createScopedDb = <TDatabase extends AnyDrizzle>(
  database: TDatabase,
  workspaceIds: string[],
  organizationId: SafeId<"organization">,
) => {
  const wsIds = `{${workspaceIds.join(",")}}`;

  return async <T>(
    fn: (tx: TransactionOf<TDatabase>) => Promise<T>,
  ): Promise<T> =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- generic AnyDrizzle constraint
    await database.transaction(async (tx: TransactionOf<TDatabase>) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- tx type is generic
      await tx.execute(
        sql`SELECT
          set_config('role', '${sql.raw(stella.name)}', true),
          set_config('${sql.raw(SETTING_WORKSPACE_IDS)}', ${wsIds}, true),
          set_config('${sql.raw(SETTING_ORGANIZATION_ID)}', ${organizationId}, true)`,
      );
      return fn(tx);
    });
};
