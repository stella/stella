import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  SETTING_ORGANIZATION_ID,
  SETTING_WORKSPACE_IDS,
  stella,
} from "@/api/db/rls";
import {
  invoiceStatusEnum,
  propertyStatusEnum,
  relations,
  timeEntrySourceEnum,
  timeEntryStatusEnum,
} from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";

// Generic constraint accepts any drizzle instance (prod or
// test PGlite) without importing test-only types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = { transaction: (fn: (tx: any) => any) => any };

export type TransactionOf<TDatabase extends AnyDrizzle> = Parameters<
  Parameters<TDatabase["transaction"]>[0]
>[0];

/**
 * Primary database handle connecting as postgres (table owner).
 * RLS is enforced per-transaction via `SET LOCAL ROLE stella`.
 *
 * All handler queries MUST go through `ScopedDb`.
 * Direct `db` usage is reserved for internal infrastructure
 * (workspace resolution in authMacro, better-auth).
 */
export const db = drizzle(env.DATABASE_URL, {
  relations: { ...relations, ...authRelationsPart },
  schema: {
    propertyStatusEnum,
    timeEntryStatusEnum,
    timeEntrySourceEnum,
    invoiceStatusEnum,
  },
});

type Database = typeof db;
export type Transaction = TransactionOf<Database>;

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
export type ScopedDb = <T>(
  fn: (tx: TransactionOf<Database>) => Promise<T>,
) => Promise<T>;

export const createScopedDb = <TDatabase extends AnyDrizzle = Database>(
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
