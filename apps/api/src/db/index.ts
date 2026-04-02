import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  invoiceStatusEnum,
  propertyStatusEnum,
  relations,
  timeEntrySourceEnum,
  timeEntryStatusEnum,
} from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { env } from "@/api/env";

// Re-export scoped utilities so existing `from "@/api/db"`
// imports keep working without pulling in db initialization.
export { createScopedDb } from "@/api/db/scoped";
export type { AnyDrizzle, TransactionOf } from "@/api/db/scoped";

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
